/**
 * Messaging plugin — server entry point.
 * Manages content Plans, Deliverables, brainstorm sessions, prep tasks, and publishing.
 */
import { z } from 'zod'
import type { BakinPlugin, PluginContext } from '@bakin/sdk/types'
import {
  brainstormThreadId,
  normalizeBrainstormActivityForStorage,
  runtimeChunkToBrainstormActivity,
} from '@bakin/sdk/utils'
import type {
  BrainstormSession,
  ContentTone,
  DeliverableDraft,
  DeliverableStatus,
  Plan,
  PlanProposal,
  PlanStatus,
  ProposalStatus,
  SessionMessage,
  MessagingSettings,
} from './types'
import { DEFAULT_CHANNEL, DEFAULT_CONTENT_TYPES } from './types'
import { buildMessages } from './lib/prompt-builder'
import {
  buildDoc as buildBrainstormDoc,
  sessionKey,
  SESSION_FILE_PATTERN,
} from './lib/brainstorm-search'
import { archiveLegacyMessagingFile } from './lib/legacy-archive'
import { normalizeContentTypesForActivate } from './lib/content-types'
import { createMessagingContentStorage } from './lib/content-storage'
import { registerMessagingDefaultWorkflows } from './lib/default-workflows'
import {
  approveAndPublishDeliverableNow,
  approveDeliverable,
  markDeliverableReadyForReview,
  rejectDeliverable,
} from './lib/deliverable-lifecycle'
import { materializeApprovedProposals } from './lib/materialize'
import type { MessagingContentStorage } from './lib/content-storage'
import { recomputePlanStatus } from './lib/plan-status'
import { runMessagingContentSweep } from './lib/sweep'
import { registerMessagingWorkflowBridge } from './lib/workflow-bridge'
import { generateId } from './lib/ids'

const log = {
  info: (...args: unknown[]) => console.info('[messaging]', ...args),
  warn: (...args: unknown[]) => console.warn('[messaging]', ...args),
  error: (...args: unknown[]) => console.error('[messaging]', ...args),
}

const SWEEP_CRON_ID = 'messaging-content-sweep'
const SWEEP_CRON_COMMAND = 'bakin:messaging:sweep'
const DEFAULT_SWEEP_CRON_SCHEDULE = '*/5 * * * *'
const LINKED_TASK_DELETE_TIMEOUT_MS = 2000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readBody<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>
}

function parseBooleanSearchParam(value: string | null): boolean | undefined {
  if (value === null) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function parseNullablePlanId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '' || value === 'null') return null
  return String(value)
}

function parseDraft(value: unknown): DeliverableDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as DeliverableDraft
}

function derivePrepStartAt(ctx: PluginContext, publishAt: string, contentTypeId: string): string {
  const publishTime = Date.parse(publishAt)
  if (Number.isNaN(publishTime)) throw new Error('publishAt must be a valid date')
  const settings = ctx.getSettings<MessagingSettings>()
  const contentTypes = settings.contentTypes ?? DEFAULT_CONTENT_TYPES
  const contentType = contentTypes.find(type => type.id === contentTypeId)
  const prepLeadHours = contentType?.prepLeadHours ?? 0
  return new Date(publishTime - prepLeadHours * 60 * 60 * 1000).toISOString()
}

function filterDeliverablesBySearchParams(
  deliverables: ReturnType<MessagingContentStorage['listDeliverables']>,
  url: URL,
) {
  const planIdParam = url.searchParams.get('planId')
  const status = url.searchParams.get('status')
  const channel = url.searchParams.get('channel')
  const publishAfter = url.searchParams.get('publishAfter') ?? url.searchParams.get('from')
  const publishBefore = url.searchParams.get('publishBefore') ?? url.searchParams.get('to')
  let filtered = deliverables
  if (planIdParam !== null) {
    const planId = parseNullablePlanId(planIdParam)
    filtered = filtered.filter(deliverable => deliverable.planId === planId)
  }
  if (status) filtered = filtered.filter(deliverable => deliverable.status === status)
  if (channel) filtered = filtered.filter(deliverable => deliverable.channel === channel)
  if (publishAfter) filtered = filtered.filter(deliverable => Date.parse(deliverable.publishAt) >= Date.parse(publishAfter))
  if (publishBefore) filtered = filtered.filter(deliverable => Date.parse(deliverable.publishAt) <= Date.parse(publishBefore))
  return filtered
}

function recomputeLinkedPlan(contentStore: MessagingContentStorage, planId: string | null | undefined): void {
  if (planId) recomputePlanStatus(contentStore, planId)
}

async function ensureMessagingSweepCron(ctx: PluginContext, schedule: string): Promise<void> {
  const job = {
    name: 'Messaging content sweep',
    schedule,
    command: SWEEP_CRON_COMMAND,
    enabled: true,
    metadata: {
      source: 'bakin',
      isBakinJob: true,
      description: 'Sweeps messaging Deliverables for prep, overdue, and publish transitions.',
    },
  }

  try {
    const existing = await ctx.runtime.cron.get(SWEEP_CRON_ID)
    if (existing) {
      await ctx.runtime.cron.update(SWEEP_CRON_ID, job)
    } else {
      await ctx.runtime.cron.create({ id: SWEEP_CRON_ID, ...job })
    }
  } catch (err) {
    log.warn('Messaging content sweep cron registration failed', { err: err instanceof Error ? err.message : String(err) })
  }
}

function buildPlanFanOutDescription(plan: Plan): string {
  const lines = [
    plan.brief || `Develop deliverables for "${plan.title}".`,
    `Plan ID: ${plan.id}`,
    `Target date: ${plan.targetDate}`,
    plan.campaign ? `Campaign: ${plan.campaign}` : undefined,
    plan.suggestedChannels?.length
      ? `Suggested channels: ${plan.suggestedChannels.join(', ')}`
      : 'Choose the right channels for this Plan.',
    'Use bakin_exec_messaging_plan_get to read full Plan context.',
    'Call bakin_exec_messaging_propose_deliverable once for each channel you intend to produce.',
  ]
  return lines.filter((line): line is string => Boolean(line)).join('\n')
}

type StartPlanFanOutResult =
  | {
    ok: true
    plan: Plan
    taskId: string
    alreadyStarted: boolean
    task?: Awaited<ReturnType<PluginContext['tasks']['create']>>
  }
  | { ok: false; error: string; status: number }

async function startPlanFanOut(
  ctx: PluginContext,
  contentStore: MessagingContentStorage,
  planId: string,
): Promise<StartPlanFanOutResult> {
  const plan = contentStore.getPlan(planId)
  if (!plan) return { ok: false, error: 'Plan not found', status: 404 }
  if (plan.fanOutTaskId) {
    return { ok: true, plan, taskId: plan.fanOutTaskId, alreadyStarted: true }
  }

  const task = await ctx.tasks.create({
    parentId: null,
    agent: plan.agent,
    column: 'todo',
    title: `Plan: ${plan.title}`,
    description: buildPlanFanOutDescription(plan),
  })
  const updated = contentStore.updatePlan(plan.id, {
    fanOutTaskId: task.id,
    status: 'planning',
  })
  ctx.activity.audit('plan.content_piece_planning_started', plan.agent, { planId: plan.id, taskId: task.id })
  ctx.activity.log(plan.agent, `Started content piece planning for "${plan.title}"`)
  return { ok: true, plan: updated, task, taskId: task.id, alreadyStarted: false }
}

async function removeLinkedTask(ctx: PluginContext, taskId: string): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ctx.tasks.remove(taskId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${LINKED_TASK_DELETE_TIMEOUT_MS}ms`))
        }, LINKED_TASK_DELETE_TIMEOUT_MS)
      }),
    ])
    return true
  } catch (err) {
    log.warn('Failed to remove linked task while deleting Messaging work', {
      taskId,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function removeLinkedTasks(ctx: PluginContext, taskIds: Iterable<string>): Promise<string[]> {
  const results = await Promise.all(
    [...new Set(taskIds)].map(async (taskId) => ({
      taskId,
      removed: await removeLinkedTask(ctx, taskId),
    })),
  )
  return results
    .filter((result) => result.removed)
    .map((result) => result.taskId)
}

async function deletePlanAndLinkedWork(
  ctx: PluginContext,
  contentStore: MessagingContentStorage,
  planId: string,
  opts: { deleteLinkedTasks?: boolean } = {},
): Promise<{ deleted: boolean; deliverableIds: string[]; taskIds: string[] }> {
  const plan = contentStore.getPlan(planId)
  if (!plan) return { deleted: false, deliverableIds: [], taskIds: [] }

  const deliverables = contentStore.listDeliverables({ planId })
  const linkedTaskIds = [
    ...(plan.fanOutTaskId ? [plan.fanOutTaskId] : []),
    ...deliverables.map((deliverable) => deliverable.taskId).filter((taskId): taskId is string => Boolean(taskId)),
  ]

  for (const deliverable of deliverables) {
    contentStore.deleteDeliverable(deliverable.id)
  }
  contentStore.deletePlan(planId)

  const removedTaskIds = opts.deleteLinkedTasks === false ? [] : await removeLinkedTasks(ctx, linkedTaskIds)
  return {
    deleted: true,
    deliverableIds: deliverables.map((deliverable) => deliverable.id),
    taskIds: removedTaskIds,
  }
}

async function deleteDeliverableAndLinkedWork(
  ctx: PluginContext,
  contentStore: MessagingContentStorage,
  deliverableId: string,
  opts: { deleteLinkedTasks?: boolean } = {},
): Promise<{ deleted: boolean; planId: string | null; taskIds: string[] }> {
  const deliverable = contentStore.getDeliverable(deliverableId)
  if (!deliverable) return { deleted: false, planId: null, taskIds: [] }

  contentStore.deleteDeliverable(deliverableId)
  recomputeLinkedPlan(contentStore, deliverable.planId)

  const taskIds = opts.deleteLinkedTasks === false || !deliverable.taskId
    ? []
    : await removeLinkedTasks(ctx, [deliverable.taskId])
  return { deleted: true, planId: deliverable.planId, taskIds }
}

interface BrainstormSessionSummary {
  id: string
  agentId: string
  title: string
  status: BrainstormSession['status']
  createdAt: string
  updatedAt: string
  proposalCount: number
  approvedCount: number
}

interface NormalizedProposalInput {
  id?: string
  title: string
  targetDate: string
  brief: string
  suggestedChannels?: string[]
}

function normalizeOptionalChannels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const channels = value
    .filter((channel): channel is string => typeof channel === 'string')
    .map(channel => channel.trim())
    .filter(Boolean)
  return channels.length > 0 ? channels : undefined
}

function normalizeProposalInput(item: unknown): NormalizedProposalInput | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  if (typeof record.title !== 'string' || typeof record.targetDate !== 'string') return null
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    title: record.title,
    targetDate: record.targetDate,
    brief: typeof record.brief === 'string' ? record.brief : '',
    suggestedChannels: normalizeOptionalChannels(record.suggestedChannels),
  }
}

function normalizeProposalInputs(items: unknown[]): NormalizedProposalInput[] {
  return items
    .map(normalizeProposalInput)
    .filter((item): item is NormalizedProposalInput => item !== null)
}

function listBrainstormSessionSummaries(
  contentStore: MessagingContentStorage,
  opts: { status?: string; agentId?: string } = {},
): BrainstormSessionSummary[] {
  return contentStore.listBrainstormSessions()
    .filter(session => !opts.status || session.status === opts.status)
    .filter(session => !opts.agentId || session.agentId === opts.agentId)
    .map(session => ({
      id: session.id,
      agentId: session.agentId,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      proposalCount: session.proposals.length,
      approvedCount: session.proposals.filter(proposal => proposal.status === 'approved').length,
    }))
}

function appendBrainstormMessage(
  contentStore: MessagingContentStorage,
  sessionId: string,
  message: {
    role: SessionMessage['role']
    content: string
    kind?: string
    data?: unknown
    agentId?: string
  },
  proposalIds?: string[],
): SessionMessage {
  const session = contentStore.getBrainstormSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  const nextMessage: SessionMessage = {
    id: generateId(),
    role: message.role,
    content: message.content,
    timestamp: new Date().toISOString(),
    proposalIds,
  }
  if (message.kind !== undefined) nextMessage.kind = message.kind
  if (message.data !== undefined) nextMessage.data = message.data
  if (message.agentId !== undefined) nextMessage.agentId = message.agentId
  contentStore.updateBrainstormSession(sessionId, {
    messages: [...session.messages, nextMessage],
  })
  return nextMessage
}

function upsertBrainstormProposals(
  contentStore: MessagingContentStorage,
  sessionId: string,
  messageId: string,
  rawItems: unknown[],
): PlanProposal[] {
  const session = contentStore.getBrainstormSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  const proposals = [...session.proposals]
  const result: PlanProposal[] = []

  for (const item of normalizeProposalInputs(rawItems)) {
    let existing = item.id ? proposals.find(proposal => proposal.id === item.id) : undefined
    if (!existing) {
      const titleLower = item.title.toLowerCase().trim()
      existing = proposals.find(proposal => proposal.title.toLowerCase().trim() === titleLower && proposal.status !== 'approved')
    }

    if (existing) {
      existing.title = item.title
      existing.targetDate = item.targetDate
      existing.brief = item.brief
      if (item.suggestedChannels !== undefined) existing.suggestedChannels = item.suggestedChannels
      existing.messageId = messageId
      existing.revision += 1
      if (existing.status === 'rejected') existing.status = 'revised'
      result.push(existing)
    } else {
      const proposal: PlanProposal = {
        id: generateId(),
        messageId,
        revision: 1,
        agentId: session.agentId,
        title: item.title,
        targetDate: item.targetDate,
        brief: item.brief,
        ...(item.suggestedChannels !== undefined ? { suggestedChannels: item.suggestedChannels } : {}),
        status: 'proposed',
      }
      proposals.push(proposal)
      result.push(proposal)
    }
  }

  if (result.length > 0) {
    contentStore.updateBrainstormSession(sessionId, { proposals })
  }
  return result
}

function updateBrainstormProposal(
  contentStore: MessagingContentStorage,
  sessionId: string,
  proposalId: string,
  updates: {
    status?: ProposalStatus
    title?: string
    brief?: string
    targetDate?: string
    suggestedChannels?: string[]
    rejectionNote?: string
  },
): PlanProposal {
  const session = contentStore.getBrainstormSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  const proposals = [...session.proposals]
  const proposal = proposals.find(item => item.id === proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)
  if (updates.status !== undefined) proposal.status = updates.status
  if (updates.title !== undefined) proposal.title = updates.title
  if (updates.brief !== undefined) proposal.brief = updates.brief
  if (updates.targetDate !== undefined) proposal.targetDate = updates.targetDate
  if (updates.suggestedChannels !== undefined) proposal.suggestedChannels = updates.suggestedChannels
  if (updates.rejectionNote !== undefined) proposal.rejectionNote = updates.rejectionNote
  contentStore.updateBrainstormSession(sessionId, { proposals })
  return proposal
}

interface AgentMetaLike { id: string; name?: string }

const AGENT_ID_SHAPE = /^[a-z0-9-]+$/

interface RuntimeChatOpts {
  agentId: string
  messages: Array<{ role: string; content: string }>
  sessionKey?: string
  signal?: AbortSignal
  model?: string
  maxTokens?: number
}

function flattenChatMessages(messages: Array<{ role: string; content: string }>): string {
  if (messages.length === 1) return messages[0].content
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n')
}

async function sendRuntimeChatCompletion(ctx: PluginContext, opts: RuntimeChatOpts): Promise<string> {
  void opts.signal
  const result = await ctx.runtime.messaging.send({
    agentId: opts.agentId,
    content: flattenChatMessages(opts.messages),
    threadId: opts.sessionKey,
    metadata: { model: opts.model, maxTokens: opts.maxTokens },
  })
  return result.content ?? ''
}

async function streamRuntimeChatCompletion(
  ctx: PluginContext,
  opts: RuntimeChatOpts,
): Promise<ReturnType<PluginContext['runtime']['messaging']['stream']>> {
  void opts.signal
  return ctx.runtime.messaging.stream({
    agentId: opts.agentId,
    content: flattenChatMessages(opts.messages),
    threadId: opts.sessionKey,
    metadata: { model: opts.model, maxTokens: opts.maxTokens },
  })
}

/**
 * Validates an agentId against a strict shape allowlist + live team roster.
 *
 * - Shape guard (load-bearing): blocks path traversal. A regex-valid id
 *   cannot escape `~/.bakin/team/personas/`.
 * - Roster check (defense-in-depth): filters orphan references — shape-valid
 *   ids that aren't in the current runtime roster. Best-effort: when the
 *   team plugin is unavailable or the hook throws, the shape guard alone
 *   suffices and messaging stays functional.
 */
async function validateAgentId(ctx: PluginContext, agentId: string): Promise<boolean> {
  if (!agentId || !AGENT_ID_SHAPE.test(agentId)) return false
  try {
    const knownIds = await ctx.hooks.invoke<string[]>('team.getAgentIds', {})
    if (Array.isArray(knownIds) && knownIds.length > 0 && !knownIds.includes(agentId)) {
      return false
    }
  } catch (err) {
    log.warn('team.getAgentIds hook failed during validation; relying on shape guard', {
      agentId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return true
}

/**
 * Resolve the prompt-builder options for a given agent. Pulls the display
 * name from the team plugin, the content-type taxonomy from this plugin's
 * settings, and the persona markdown from disk — but only after the agentId
 * clears `validateAgentId`. Invalid ids return an empty persona; callers
 * that care about the distinction should gate with validateAgentId directly.
 */
async function resolvePromptOptions(ctx: PluginContext, agentId: string) {
  const valid = await validateAgentId(ctx, agentId)
  let persona = ''
  if (valid) {
    try {
      const profile = await ctx.hooks.invoke<{ soul?: string } | null>('team.resolveProfile', { id: agentId })
      persona = profile?.soul ?? ''
    } catch (err) {
      log.warn('team.resolveProfile hook failed during persona lookup', { agentId, err: err instanceof Error ? err.message : String(err) })
    }
  }

  let agentName: string | undefined
  try {
    const agent = await ctx.hooks.invoke<AgentMetaLike | null>('team.getAgent', { id: agentId })
    agentName = agent?.name
  } catch (err) {
    log.warn('team.getAgent hook failed; falling back to raw agentId', { agentId, err: err instanceof Error ? err.message : String(err) })
  }

  const settings = ctx.getSettings<MessagingSettings>()
  const contentTypes = settings.contentTypes ?? DEFAULT_CONTENT_TYPES
  return { agentName, contentTypes, persona }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const messagingPlugin: BakinPlugin = {
  id: 'messaging',
  name: 'Messaging',
  version: '2.0.0',

  settingsSchema: {
    fields: [
      { key: 'defaultView', type: 'select', label: 'Default view', description: 'Default messaging view on page load', options: [{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'list', label: 'List' }], default: 'month' },
      { key: 'showScheduleJobs', type: 'boolean', label: 'Show schedule jobs', description: 'Display recurring schedule jobs on the content calendar', default: false },
      { key: 'channels', type: 'string', label: 'Channels', description: 'Comma-separated runtime channel IDs available for distribution (e.g., general,announcements,email)', default: DEFAULT_CHANNEL },
      {
        key: 'contentTypes',
        type: 'list',
        label: 'Content types',
        description: 'Categories used across the content calendar and brainstorm proposals.',
        addLabel: 'Add content type',
        minItems: 1,
        uniqueField: 'id',
        itemShape: {
          id:               { key: 'id',               type: 'string',  label: 'ID',                description: 'Machine id — lowercase, no spaces (e.g. "blog").', required: true },
          label:            { key: 'label',            type: 'string',  label: 'Label',             description: 'Display name shown in menus.', required: true },
          prepLeadHours:    { key: 'prepLeadHours',    type: 'number',  label: 'Prep lead hours',   description: 'How many hours before publish time prep should start.' },
          workflowId:       { key: 'workflowId',       type: 'string',  label: 'Workflow ID',       description: 'Optional workflow definition for prep.' },
          requiresApproval: { key: 'requiresApproval', type: 'boolean', label: 'Requires approval', description: 'Bare-task path requires review before publish.', default: true },
          defaultAgent:     { key: 'defaultAgent',     type: 'string',  label: 'Default agent',     description: 'Optional default prep agent for this content type.' },
          assetRequirement: {
            key: 'assetRequirement',
            type: 'select',
            label: 'Asset requirement',
            description: 'Asset validation rule before approval or publish.',
            options: [
              { value: 'none', label: 'None' },
              { value: 'optional-image', label: 'Optional image' },
              { value: 'image', label: 'Required image' },
              { value: 'optional-video', label: 'Optional video' },
              { value: 'video', label: 'Required video' },
            ],
          },
        },
      },
    ],
  },

  navItems: [
    { id: 'messaging', label: 'Messaging', icon: 'MessageSquare', href: '/messaging', order: 25 },
  ],

  contentFiles: [],

  async activate(ctx: PluginContext) {
    const legacyArchive = archiveLegacyMessagingFile(ctx.storage)
    if (legacyArchive.archived) {
      ctx.activity.audit('legacy.archived', 'system', { from: legacyArchive.from, to: legacyArchive.to })
      log.info('Archived legacy messaging.json', legacyArchive)
    }

    const contentStore = createMessagingContentStorage(ctx.storage)

    const defaultWorkflows = registerMessagingDefaultWorkflows(ctx, undefined, log)
    if (defaultWorkflows.registered.length > 0) {
      log.info(`Registered ${defaultWorkflows.registered.length} messaging workflow(s)`, {
        ids: defaultWorkflows.registered,
      })
    }

    // ── Seed default content types on first activate ──────────────────
    const currentSettings = ctx.getSettings<MessagingSettings>()
    const normalizedSettings = await normalizeContentTypesForActivate(
      ctx,
      currentSettings.contentTypes,
      (message, data) => log.warn(message, data),
    )
    if (normalizedSettings.changed) {
      ctx.updateSettings({ contentTypes: normalizedSettings.contentTypes })
      log.info(`Normalized ${normalizedSettings.contentTypes.length} messaging content types`)
    }

    ctx.hooks.register('messaging.sweep.run', async () => runMessagingContentSweep(contentStore, ctx, ctx.getSettings<MessagingSettings>()), {
      hookKind: 'rpc',
      label: 'Run messaging content sweep',
      summary: 'Run messaging content sweep',
    })
    registerMessagingWorkflowBridge(contentStore, ctx, () => ctx.getSettings<MessagingSettings>(), log)
    await ensureMessagingSweepCron(ctx, currentSettings.sweepCronSchedule ?? DEFAULT_SWEEP_CRON_SCHEDULE)

    // ── Search Content Type Registration ─────────────────────────────
    // Brainstorm sessions are indexed for cross-plugin search. Calendar and
    // Plan views use local filters over Deliverables and Plans.
    const sessionFilePattern = ctx.storage.searchPath?.(SESSION_FILE_PATTERN) ?? SESSION_FILE_PATTERN
    ctx.search.registerFileBackedContentType({
      table: 'messaging_brainstorm',
      schema: {
        session_id: { type: 'keyword' },
        title: { type: 'text' },
        status: { type: 'keyword' },
        agent_id: { type: 'keyword' },
        message_body: { type: 'text' },
        proposal_summaries: { type: 'text' },
        created_at: { type: 'datetime' },
        updated_at: { type: 'datetime' },
      },
      searchableFields: ['title', 'message_body', 'proposal_summaries'],
      rerankField: 'message_body',
      embeddingTemplate: '{{title}} — {{message_body}} — {{proposal_summaries}}',
      facets: ['status', 'agent_id'],
      filePatterns: [
        {
          pattern: sessionFilePattern,
          fileToId: (rel) => {
            const id = rel.split('/').pop()?.replace(/\.json$/, '') ?? ''
            return id ? sessionKey(id) : null
          },
          fileToDoc: async (_rel, content) => {
            try {
              const parsed = JSON.parse(content) as BrainstormSession
              if (!parsed || typeof parsed.id !== 'string') return null
              if (!Array.isArray(parsed.messages)) parsed.messages = []
              if (!Array.isArray(parsed.proposals)) parsed.proposals = []
              return buildBrainstormDoc(parsed)
            } catch {
              return null
            }
          },
        },
      ],
      reindex: async function* () {
        for (const session of contentStore.listBrainstormSessions()) {
          yield { key: sessionKey(session.id), doc: buildBrainstormDoc(session) }
        }
      },
      verifyExists: async (key: string) => {
        if (!key.startsWith('brainstorm-')) return false
        const id = key.slice('brainstorm-'.length)
        return ctx.storage.exists(`messaging/sessions/${id}.json`)
      },
    })

    // ── API Routes ─────────────────────────────────────────────────────

    // POST /brainstorm — one-shot Plan brainstorming
    ctx.registerRoute({
      path: '/brainstorm',
      method: 'POST',
      handler: async (req: Request) => {
        const body = await readBody<{
          agentId: string
          message: string
          history: { role: string; content: string }[]
        }>(req)

        if (!body.agentId || !body.message) {
          return json({ error: 'agentId and message required' }, 400)
        }
        if (!(await validateAgentId(ctx, body.agentId))) {
          return json({ error: 'invalid agentId' }, 400)
        }

        try {
          const { agentName: resolvedName, persona } = await resolvePromptOptions(ctx, body.agentId)
          const agentName = resolvedName || body.agentId

          const historyContext = (body.history || []).map(h =>
            `${h.role === 'user' ? 'Mark' : agentName}: ${h.content}`
          ).join('\n\n')

          const fullPrompt = `You are ${agentName}. Here is your persona:

${persona}

---

You are brainstorming content topics with Mark. Suggest Plan proposals, one topic or one day's focus per proposal.

For each suggestion provide:
- title: punchy topic title in your voice
- targetDate: ISO date (timezone: America/Denver, MDT)
- brief: 2-3 sentence focus describing the topic and angle
- suggestedChannels: optional array of channel hints

HARD RULE: If Mark requests any concrete content topic, emit a JSON proposal block.
HARD RULE: Emit each Plan as its own fenced JSON block, one object per block, not an array.

Format: conversational response in your voice, then one or more JSON blocks:
\`\`\`json
{ "title": "...", "targetDate": "2026-05-19", "brief": "...", "suggestedChannels": ["blog"] }
\`\`\`

${historyContext ? `Conversation so far:\n${historyContext}\n\n` : ''}Mark says: ${body.message}`

          const sessionKey = `brainstorm-${body.agentId}-${Date.now()}`
          const content = await sendRuntimeChatCompletion(ctx, {
            agentId: body.agentId,
            sessionKey,
            messages: [{ role: 'user', content: fullPrompt }],
          })

          let suggestions: Array<{
            title: string
            targetDate: string
            brief: string
            suggestedChannels?: string[]
          }> = []

          const blockRegex = /```json\s*([\s\S]*?)\s*```/g
          let match: RegExpExecArray | null
          while ((match = blockRegex.exec(content)) !== null) {
            try {
              const parsed = JSON.parse(match[1])
              suggestions.push(...(Array.isArray(parsed) ? parsed : [parsed]))
            } catch { /* ignore */ }
          }

          return json({
            response: content.replace(/```json[\s\S]*?```/g, '').trim(),
            suggestions,
          })
        } catch (err) {
          log.error('Brainstorm error', err)
          return json({ error: err instanceof Error ? err.message : String(err) }, 500)
        }
      },
    })

    // ── Session Routes ──────────────────────────────────────────────────

    // GET /sessions — list planning sessions
    ctx.registerRoute({
      path: '/sessions',
      method: 'GET',
      description: 'List planning sessions',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const status = url.searchParams.get('status') || undefined
        const agentId = url.searchParams.get('agentId') || undefined
        const sessions = listBrainstormSessionSummaries(contentStore, { status, agentId })
        return json({ sessions })
      },
    })

    // GET /sessions/:id — get full session
    ctx.registerRoute({
      path: '/sessions/:id',
      method: 'GET',
      description: 'Get a planning session',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const id = url.searchParams.get('id')
        if (!id) return json({ error: 'id required' }, 400)
        const session = contentStore.getBrainstormSession(id)
        if (!session) return json({ error: 'Session not found' }, 404)
        return json({ session })
      },
    })

    // POST /sessions — create session
    ctx.registerRoute({
      path: '/sessions',
      method: 'POST',
      description: 'Create a planning session',
      handler: async (req: Request) => {
        const body = await readBody<{ agentId?: string; title?: string; scope?: string }>(req)
        if (!body.agentId) return json({ error: 'agentId required' }, 400)
        if (!(await validateAgentId(ctx, body.agentId))) {
          return json({ error: 'invalid agentId' }, 400)
        }
        const session = contentStore.createBrainstormSession({
          agentId: body.agentId,
          title: body.title || 'New brainstorm session',
          scope: body.scope,
        })
        ctx.activity.audit('session.created', body.agentId, { sessionId: session.id })
        ctx.activity.log(body.agentId, `Created planning session "${session.title}"`)
        return json({ ok: true, session })
      },
    })

    // PUT /sessions/:id — update session metadata
    ctx.registerRoute({
      path: '/sessions/:id',
      method: 'PUT',
      description: 'Update a planning session',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string; title?: string; status?: BrainstormSession['status'] }>(req)
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        try {
          const session = contentStore.updateBrainstormSession(id, { title: body.title, status: body.status })
          return json({ ok: true, session })
        } catch (e: unknown) {
          return json({ error: (e as Error).message }, 404)
        }
      },
    })

    // DELETE /sessions/:id — delete session
    ctx.registerRoute({
      path: '/sessions/:id',
      method: 'DELETE',
      description: 'Delete a planning session and optionally the Plans prepared from it',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const hasQueryOptions = url.searchParams.has('id')
          && url.searchParams.has('deleteCreatedPlans')
          && url.searchParams.has('deleteLinkedTasks')
        const body: {
          id?: string
          deleteCreatedPlans?: boolean
          deleteLinkedTasks?: boolean
        } = hasQueryOptions ? {} : await readBody<{
          id?: string
          deleteCreatedPlans?: boolean
          deleteLinkedTasks?: boolean
        }>(req).catch(() => ({} as {
          id?: string
          deleteCreatedPlans?: boolean
          deleteLinkedTasks?: boolean
        }))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const session = contentStore.getBrainstormSession(id)
        if (!session) return json({ error: 'Session not found' }, 404)
        const deleteCreatedPlans = parseBooleanSearchParam(url.searchParams.get('deleteCreatedPlans')) ?? body.deleteCreatedPlans
        const deleteLinkedTasks = parseBooleanSearchParam(url.searchParams.get('deleteLinkedTasks')) ?? body.deleteLinkedTasks
        const deletedPlanIds: string[] = []
        const deletedTaskIds: string[] = []
        if (deleteCreatedPlans !== false) {
          const planIds = new Set([
            ...session.createdAtPlanIds,
            ...contentStore.listPlans()
              .filter((plan) => plan.sourceSessionId === session.id)
              .map((plan) => plan.id),
          ])
          for (const planId of planIds) {
            const result = await deletePlanAndLinkedWork(ctx, contentStore, planId, {
              deleteLinkedTasks,
            })
            if (result.deleted) deletedPlanIds.push(planId)
            deletedTaskIds.push(...result.taskIds)
          }
        }
        contentStore.deleteBrainstormSession(id)
        ctx.activity.audit('session.deleted', 'system', { sessionId: id, deletedPlanIds, deletedTaskIds })
        ctx.activity.log('system', `Deleted planning session ${id}`)
        return json({ ok: true, planIds: deletedPlanIds, taskIds: deletedTaskIds })
      },
    })

    // POST /sessions/:id/messages — send message with SSE streaming
    ctx.registerRoute({
      path: '/sessions/:id/messages',
      method: 'POST',
      description: 'Send a message in a planning session (SSE streaming)',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string; message?: string }>(req)
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        if (!body.message) return json({ error: 'message required' }, 400)

        const session = contentStore.getBrainstormSession(id)
        if (!session) return json({ error: 'Session not found' }, 404)
        if (session.status === 'archived') return json({ error: 'Session is archived' }, 400)

        // Append user message
        appendBrainstormMessage(contentStore, id, { role: 'user', content: body.message })

        // Build current-turn prompt; durable history is held by the runtime
        // adapter through the stable threadId.
        const promptOptions = await resolvePromptOptions(ctx, session.agentId)
        const messages = buildMessages(session, body.message, promptOptions)
        const sessionKey = brainstormThreadId('messaging', id, session.agentId)

        // Create a ReadableStream that pipes runtime SSE to the client
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()

            function send(event: string, data: unknown): void {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            }

            try {
              let fullContent = ''
              // Track proposals emitted incrementally during streaming
              const streamedProposalIds: string[] = []
              const sessionId = id as string // narrowed by early return above

              /**
               * Check fullContent for newly completed ```json blocks.
               * Parse and upsert each one, emit SSE event immediately.
               * Uses a temp message ID during streaming; patched to real ID after.
               */
              function checkForCompletedBlocks(): void {
                // Find all complete ```json...``` blocks we haven't processed yet
                const processed = streamedProposalIds.length
                const blockRegex = /```json\s*\n([\s\S]*?)```/g
                let match: RegExpExecArray | null
                let blockIndex = 0
                while ((match = blockRegex.exec(fullContent)) !== null) {
                  if (blockIndex < processed) { blockIndex++; continue }
                  try {
                    const parsed = JSON.parse(match[1].trim())
                    const items = Array.isArray(parsed) ? parsed : [parsed]
                    const saved = upsertBrainstormProposals(contentStore, sessionId, `streaming-${Date.now()}`, items)
                    for (const p of saved) {
                      streamedProposalIds.push(p.id)
                      send('proposal', { proposal: p })
                    }
                  } catch {
                    // JSON not valid yet or malformed — skip
                  }
                  blockIndex++
                }
              }

              // Try streaming first, fall back to non-streaming
              let useStreaming = true
              let runtimeChunks: ReturnType<PluginContext['runtime']['messaging']['stream']> | null = null

              try {
                runtimeChunks = await streamRuntimeChatCompletion(ctx, {
                  messages,
                  agentId: session.agentId,
                  sessionKey,
                })
              } catch {
                // Runtime doesn't support streaming — fall back
                useStreaming = false
                runtimeChunks = null
              }

              if (useStreaming && runtimeChunks) {
                for await (const chunk of runtimeChunks) {
                  if (chunk.type === 'text' && chunk.content) {
                    fullContent += chunk.content
                    send('token', { text: chunk.content })
                    // Check if a ```json block just completed
                    if (chunk.content.includes('`')) {
                      checkForCompletedBlocks()
                    }
                  } else if (chunk.type === 'error') {
                    throw new Error(chunk.content ?? 'Runtime stream error')
                  } else {
                    const activity = runtimeChunkToBrainstormActivity(chunk)
                    const normalized = activity ? normalizeBrainstormActivityForStorage(activity) : null
                    if (normalized) {
                      appendBrainstormMessage(contentStore, sessionId, {
                        role: 'activity',
                        content: normalized.content,
                        kind: normalized.kind,
                        data: normalized.data,
                        agentId: session.agentId,
                      })
                      send('activity', { activity: normalized })
                    }
                  }
                }
              } else {
                // Non-streaming fallback
                try {
                  fullContent = await sendRuntimeChatCompletion(ctx, {
                    messages,
                    agentId: session.agentId,
                    sessionKey,
                  })
                  // Send entire response as a single token event
                  send('token', { text: fullContent })
                } catch (err) {
                  send('error', { message: err instanceof Error ? err.message : String(err) })
                  controller.close()
                  return
                }
              }

              // Final pass: pick up any remaining ```json blocks not caught during streaming
              checkForCompletedBlocks()

              // Also handle legacy array format (single block with [...])
              if (streamedProposalIds.length === 0) {
                const jsonMatch = fullContent.match(/```json\s*([\s\S]*?)\s*```/)
                if (jsonMatch) {
                  try {
                    const parsed = JSON.parse(jsonMatch[1].trim())
                    const items = Array.isArray(parsed) ? parsed : [parsed]
                    const saved = upsertBrainstormProposals(contentStore, sessionId, `final-${Date.now()}`, items)
                    for (const p of saved) {
                      streamedProposalIds.push(p.id)
                      send('proposal', { proposal: p })
                    }
                  } catch { /* ignore malformed JSON */ }
                }
              }

              // Split content at JSON block boundaries into separate messages
              // e.g. "intro text ```json...``` day one text ```json...``` closing"
              // becomes 3 messages: "intro text", "day one text", "closing"
              const segments = fullContent
                .split(/```json[\s\S]*?```/)
                .map(s => s.trim())
                .filter(s => s.length > 0)

              const messageIds: string[] = []
              for (const segment of segments) {
                const msg = appendBrainstormMessage(contentStore, sessionId, {
                  role: 'assistant',
                  content: segment,
                })
                messageIds.push(msg.id)
              }

              // If no text segments (pure JSON response), save a placeholder
              if (messageIds.length === 0) {
                const msg = appendBrainstormMessage(contentStore, sessionId, {
                  role: 'assistant',
                  content: '',
                }, streamedProposalIds)
                messageIds.push(msg.id)
              }

              // Link proposals to the first message and patch messageIds on proposals
              if (streamedProposalIds.length > 0) {
                const reloadedSession = contentStore.getBrainstormSession(sessionId)
                if (reloadedSession) {
                  // Attach proposalIds to the first assistant message
                  const firstMsg = reloadedSession.messages.find(m => m.id === messageIds[0])
                  if (firstMsg) firstMsg.proposalIds = streamedProposalIds

                  // Patch proposal messageIds to real assistant message
                  for (const p of reloadedSession.proposals) {
                    if (streamedProposalIds.includes(p.id)) {
                      p.messageId = messageIds[0]
                    }
                  }
                  contentStore.updateBrainstormSession(sessionId, {
                    messages: reloadedSession.messages,
                    proposals: reloadedSession.proposals,
                  })
                }
              }

              send('done', {
                messageId: messageIds[0],
                content: segments.join('\n\n'),
                segments: segments.map((content, i) => ({
                  id: messageIds[i],
                  content,
                })),
              })
            } catch (err) {
              send('error', { message: err instanceof Error ? err.message : String(err) })
            } finally {
              controller.close()
            }
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        })
      },
    })

    // PUT /sessions/:id/proposals/:proposalId — update proposal
    ctx.registerRoute({
      path: '/sessions/:id/proposals/:proposalId',
      method: 'PUT',
      description: 'Update a proposal in a planning session',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<Record<string, unknown>>(req)
        const sessionId = url.searchParams.get('id')
        const proposalId = url.searchParams.get('proposalId')
        if (!sessionId || !proposalId) return json({ error: 'sessionId and proposalId required' }, 400)
        try {
          const proposal = updateBrainstormProposal(contentStore, sessionId, proposalId, {
            status: body.status as ProposalStatus | undefined,
            title: body.title as string | undefined,
            brief: body.brief as string | undefined,
            targetDate: body.targetDate as string | undefined,
            suggestedChannels: body.suggestedChannels as string[] | undefined,
            rejectionNote: body.rejectionNote as string | undefined,
          })
          return json({ ok: true, proposal })
        } catch (e: unknown) {
          return json({ error: (e as Error).message }, 404)
        }
      },
    })

    ctx.registerRoute({
      path: '/sessions/:id/materialize',
      method: 'POST',
      description: 'Prepare Plans from accepted brainstorm proposals',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string }>(req).catch(() => ({} as { id?: string }))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const session = contentStore.getBrainstormSession(id)
        if (!session) return json({ error: 'Session not found' }, 404)
        const result = materializeApprovedProposals(session, contentStore)
        contentStore.updateBrainstormSession(session.id, {
          proposals: session.proposals,
          createdAtPlanIds: session.createdAtPlanIds,
        })
        ctx.activity.audit('session.materialized', 'system', { sessionId: id, planIds: result.planIds })
        ctx.activity.log('system', `Created ${result.planIds.length} Plan(s) from "${session.title}"`)
        return json({ ok: true, ...result })
      },
    })

    // ── Plan Routes ────────────────────────────────────────────────────

    ctx.registerRoute({
      path: '/plans',
      method: 'GET',
      description: 'List content Plans',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const status = url.searchParams.get('status')
        const agent = url.searchParams.get('agent')
        const campaign = url.searchParams.get('campaign')
        let plans = contentStore.listPlans()
        if (status) plans = plans.filter(plan => plan.status === status)
        if (agent) plans = plans.filter(plan => plan.agent === agent)
        if (campaign) plans = plans.filter(plan => plan.campaign === campaign)
        return json({ plans })
      },
    })

    ctx.registerRoute({
      path: '/plans/:id',
      method: 'GET',
      description: 'Get a content Plan',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const id = url.searchParams.get('id')
        if (!id) return json({ error: 'id required' }, 400)
        const plan = contentStore.getPlan(id)
        if (!plan) return json({ error: 'Plan not found' }, 404)
        return json({ plan, deliverables: contentStore.listDeliverables({ planId: id }) })
      },
    })

    ctx.registerRoute({
      path: '/plans',
      method: 'POST',
      description: 'Create a content Plan',
      handler: async (req: Request) => {
        const body = await readBody<Record<string, unknown>>(req)
        if (!body.title || !body.targetDate || !body.agent) {
          return json({ error: 'title, targetDate, and agent required' }, 400)
        }
        const plan = contentStore.createPlan({
          title: body.title as string,
          brief: (body.brief as string | undefined) ?? '',
          targetDate: body.targetDate as string,
          agent: body.agent as string,
          campaign: body.campaign as string | undefined,
          suggestedChannels: body.suggestedChannels as string[] | undefined,
        })
        ctx.activity.audit('plan.created', body.agent as string, { planId: plan.id, title: plan.title })
        ctx.activity.log(body.agent as string, `Created content Plan "${plan.title}"`)
        return json({ ok: true, plan })
      },
    })

    ctx.registerRoute({
      path: '/plans/:id',
      method: 'PUT',
      description: 'Update a content Plan',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<Record<string, unknown>>(req)
        const id = url.searchParams.get('id') || body.id as string | undefined
        if (!id) return json({ error: 'id required' }, 400)
        try {
          const plan = contentStore.updatePlan(id, {
            title: body.title as string | undefined,
            brief: body.brief as string | undefined,
            targetDate: body.targetDate as string | undefined,
            agent: body.agent as string | undefined,
            status: body.status as PlanStatus | undefined,
            campaign: body.campaign as string | undefined,
            suggestedChannels: body.suggestedChannels as string[] | undefined,
          })
          ctx.activity.audit('plan.updated', 'system', { planId: id })
          return json({ ok: true, plan })
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 404)
        }
      },
    })

    ctx.registerRoute({
      path: '/plans/:id',
      method: 'DELETE',
      description: 'Delete a content Plan, its content pieces, and linked board tasks',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const hasQueryOptions = url.searchParams.has('id') && url.searchParams.has('deleteLinkedTasks')
        const body: { id?: string; deleteLinkedTasks?: boolean } = hasQueryOptions ? {} : await readBody<{ id?: string; deleteLinkedTasks?: boolean }>(req)
          .catch((): { id?: string; deleteLinkedTasks?: boolean } => ({}))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const deleteLinkedTasks = parseBooleanSearchParam(url.searchParams.get('deleteLinkedTasks')) ?? body.deleteLinkedTasks
        const result = await deletePlanAndLinkedWork(ctx, contentStore, id, {
          deleteLinkedTasks,
        })
        if (!result.deleted) return json({ error: 'Plan not found' }, 404)
        ctx.activity.audit('plan.deleted', 'system', { planId: id, deliverableIds: result.deliverableIds, taskIds: result.taskIds })
        return json({ ok: true, deliverableIds: result.deliverableIds, taskIds: result.taskIds })
      },
    })

    ctx.registerRoute({
      path: '/plans/:id/start-fanout',
      method: 'POST',
      description: 'Create the content piece planning task for a content Plan',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string }>(req).catch((): { id?: string } => ({}))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const result = await startPlanFanOut(ctx, contentStore, id)
        if (!result.ok) return json({ error: result.error }, result.status)
        return json(result)
      },
    })

    // ── Deliverable Routes ─────────────────────────────────────────────

    ctx.registerRoute({
      path: '/deliverables',
      method: 'GET',
      description: 'List content Deliverables',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        return json({ deliverables: filterDeliverablesBySearchParams(contentStore.listDeliverables(), url) })
      },
    })

    ctx.registerRoute({
      path: '/deliverables/:id',
      method: 'GET',
      description: 'Get a content Deliverable',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const id = url.searchParams.get('id')
        if (!id) return json({ error: 'id required' }, 400)
        const deliverable = contentStore.getDeliverable(id)
        if (!deliverable) return json({ error: 'Deliverable not found' }, 404)
        return json({ deliverable })
      },
    })

    ctx.registerRoute({
      path: '/deliverables',
      method: 'POST',
      description: 'Create a content Deliverable',
      handler: async (req: Request) => {
        const body = await readBody<Record<string, unknown>>(req)
        if (!body.title || !body.brief || !body.channel || !body.contentType || !body.tone || !body.agent || !body.publishAt) {
          return json({ error: 'title, brief, channel, contentType, tone, agent, and publishAt required' }, 400)
        }
        const planId = parseNullablePlanId(body.planId) ?? null
        if (planId && !contentStore.getPlan(planId)) return json({ error: 'Plan not found' }, 404)
        try {
          const contentType = body.contentType as string
          const publishAt = body.publishAt as string
          const deliverable = contentStore.createDeliverable({
            planId,
            channel: body.channel as string,
            contentType,
            tone: body.tone as ContentTone,
            agent: body.agent as string,
            title: body.title as string,
            brief: body.brief as string,
            publishAt,
            prepStartAt: (body.prepStartAt as string | undefined) ?? derivePrepStartAt(ctx, publishAt, contentType),
            prepStartAtOverride: body.prepStartAtOverride as string | undefined,
            status: (body.status as DeliverableStatus | undefined) ?? 'planned',
            draft: parseDraft(body.draft),
          })
          recomputeLinkedPlan(contentStore, planId)
          ctx.activity.audit('deliverable.created', body.agent as string, { deliverableId: deliverable.id, planId })
          ctx.activity.log(body.agent as string, `Created content Deliverable "${deliverable.title}"`)
          return json({ ok: true, deliverable })
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    })

    ctx.registerRoute({
      path: '/deliverables/:id',
      method: 'PUT',
      description: 'Update a content Deliverable',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<Record<string, unknown>>(req)
        const id = url.searchParams.get('id') || body.id as string | undefined
        if (!id) return json({ error: 'id required' }, 400)
        const existing = contentStore.getDeliverable(id)
        if (!existing) return json({ error: 'Deliverable not found' }, 404)
        const planId = parseNullablePlanId(body.planId)
        if (planId && !contentStore.getPlan(planId)) return json({ error: 'Plan not found' }, 404)
        const contentType = body.contentType as string | undefined
        const publishAt = body.publishAt as string | undefined
        const shouldDerivePrepStartAt = !body.prepStartAt && (contentType || publishAt)
        try {
          const deliverable = contentStore.updateDeliverable(id, {
            planId,
            channel: body.channel as string | undefined,
            contentType,
            tone: body.tone as ContentTone | undefined,
            agent: body.agent as string | undefined,
            title: body.title as string | undefined,
            brief: body.brief as string | undefined,
            publishAt,
            prepStartAt: (body.prepStartAt as string | undefined)
              ?? (shouldDerivePrepStartAt ? derivePrepStartAt(ctx, publishAt ?? existing.publishAt, contentType ?? existing.contentType) : undefined),
            prepStartAtOverride: body.prepStartAtOverride as string | undefined,
            status: body.status as DeliverableStatus | undefined,
            draft: parseDraft(body.draft),
            rejectionNote: body.rejectionNote as string | undefined,
          })
          recomputeLinkedPlan(contentStore, existing.planId)
          if (deliverable.planId !== existing.planId) recomputeLinkedPlan(contentStore, deliverable.planId)
          ctx.activity.audit('deliverable.updated', 'system', { deliverableId: id, planId: deliverable.planId })
          return json({ ok: true, deliverable })
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    })

    ctx.registerRoute({
      path: '/deliverables/:id',
      method: 'DELETE',
      description: 'Delete a content Deliverable',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const hasQueryOptions = url.searchParams.has('id') && url.searchParams.has('deleteLinkedTasks')
        const body: { id?: string; deleteLinkedTasks?: boolean } = hasQueryOptions ? {} : await readBody<{ id?: string; deleteLinkedTasks?: boolean }>(req)
          .catch((): { id?: string; deleteLinkedTasks?: boolean } => ({}))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const deleteLinkedTasks = parseBooleanSearchParam(url.searchParams.get('deleteLinkedTasks')) ?? body.deleteLinkedTasks
        const result = await deleteDeliverableAndLinkedWork(ctx, contentStore, id, {
          deleteLinkedTasks,
        })
        if (!result.deleted) return json({ error: 'Deliverable not found' }, 404)
        ctx.activity.audit('deliverable.deleted', 'system', { deliverableId: id, planId: result.planId, taskIds: result.taskIds })
        return json({ ok: true, taskIds: result.taskIds })
      },
    })

    ctx.registerRoute({
      path: '/deliverables/:id/approve',
      method: 'POST',
      description: 'Approve a content Deliverable',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string }>(req).catch((): { id?: string } => ({}))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const result = await approveDeliverable(contentStore, ctx, ctx.getSettings<MessagingSettings>(), id)
        if (!result.ok) return json({ error: result.error, deliverable: result.deliverable }, result.status)
        return json({ ok: true, deliverable: result.deliverable })
      },
    })

    ctx.registerRoute({
      path: '/deliverables/:id/reject',
      method: 'POST',
      description: 'Reject a content Deliverable',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string; note?: string; reason?: string }>(req).catch(() => ({} as { id?: string; note?: string; reason?: string }))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const result = await rejectDeliverable(contentStore, ctx, id, body.note ?? body.reason ?? '')
        if (!result.ok) return json({ error: result.error, deliverable: result.deliverable }, result.status)
        return json({ ok: true, deliverable: result.deliverable })
      },
    })

    ctx.registerRoute({
      path: '/deliverables/:id/approve-and-publish-now',
      method: 'POST',
      description: 'Approve and immediately publish a bare-task Deliverable',
      handler: async (req: Request) => {
        const url = new URL(req.url)
        const body = await readBody<{ id?: string }>(req).catch((): { id?: string } => ({}))
        const id = url.searchParams.get('id') || body.id
        if (!id) return json({ error: 'id required' }, 400)
        const result = await approveAndPublishDeliverableNow(contentStore, ctx, ctx.getSettings<MessagingSettings>(), id)
        if (!result.ok) return json({ error: result.error, deliverable: result.deliverable }, result.status)
        return json({ ok: true, deliverable: result.deliverable, published: result.published })
      },
    })

    // ── Exec Tools (agent-facing) ─────────────────────────────────────

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_plan_list',
      label: 'Listed content plans',
      description: 'List content Plans with optional filters',
      parameters: {
        status: z.string().optional().describe('Filter by Plan status'),
        agent: z.string().optional().describe('Filter by lead agent'),
        campaign: z.string().optional().describe('Filter by campaign'),
      },
      handler: async (params: Record<string, unknown>) => {
        let plans = contentStore.listPlans()
        if (params.status) plans = plans.filter(plan => plan.status === params.status)
        if (params.agent) plans = plans.filter(plan => plan.agent === params.agent)
        if (params.campaign) plans = plans.filter(plan => plan.campaign === params.campaign)
        return { ok: true, count: plans.length, plans }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_plan_get',
      label: 'Read content plan',
      description: 'Get a content Plan and its Deliverables',
      parameters: {
        planId: z.string().describe('Plan ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.planId) return { ok: false, error: 'planId required' }
        const plan = contentStore.getPlan(params.planId as string)
        if (!plan) return { ok: false, error: 'Plan not found' }
        return { ok: true, plan, deliverables: contentStore.listDeliverables({ planId: plan.id }) }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_plan_create',
      label: 'Created content plan',
      activityDuplicate: true,
      description: 'Create a content Plan',
      parameters: {
        title: z.string().describe('Plan title'),
        targetDate: z.string().describe('Target ISO date'),
        agent: z.string().describe('Lead agent'),
        brief: z.string().optional().describe('Plan brief'),
        campaign: z.string().optional().describe('Campaign tag'),
        suggestedChannels: z.array(z.string()).optional().describe('Suggested channel IDs'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.title || !params.targetDate || !params.agent) {
          return { ok: false, error: 'title, targetDate, and agent required' }
        }
        const plan = contentStore.createPlan({
          title: params.title as string,
          brief: (params.brief as string | undefined) ?? '',
          targetDate: params.targetDate as string,
          agent: params.agent as string,
          campaign: params.campaign as string | undefined,
          suggestedChannels: params.suggestedChannels as string[] | undefined,
        })
        ctx.activity.audit('plan.created', params.agent as string, { planId: plan.id, title: plan.title })
        return { ok: true, plan }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_plan_delete',
      label: 'Deleted content plan',
      activityDuplicate: true,
      description: 'Delete a content Plan, its content pieces, and linked board tasks.',
      parameters: {
        planId: z.string().describe('Plan ID (required)'),
        deleteLinkedTasks: z.boolean().optional().describe('Delete linked board tasks; defaults to true'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.planId) return { ok: false, error: 'planId required' }
        const result = await deletePlanAndLinkedWork(ctx, contentStore, params.planId as string, {
          deleteLinkedTasks: params.deleteLinkedTasks as boolean | undefined,
        })
        if (!result.deleted) return { ok: false, error: 'Plan not found' }
        ctx.activity.audit('plan.deleted', 'system', {
          planId: params.planId,
          deliverableIds: result.deliverableIds,
          taskIds: result.taskIds,
        })
        return { ok: true, deliverableIds: result.deliverableIds, taskIds: result.taskIds }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_plan_start_fanout',
      label: 'Started content piece planning',
      activityDuplicate: true,
      description: 'Create the content piece planning task for a content Plan',
      parameters: {
        planId: z.string().describe('Plan ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.planId) return { ok: false, error: 'planId required' }
        const result = await startPlanFanOut(ctx, contentStore, params.planId as string)
        if (!result.ok) return { ok: false, error: result.error }
        return result
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_propose_deliverable',
      label: 'Proposed content deliverable',
      activityDuplicate: true,
      description: 'Propose a channel-specific content piece for a content Plan.',
      parameters: {
        planId: z.string().describe('Plan ID (required)'),
        channel: z.string().describe('Runtime channel ID'),
        contentType: z.string().describe('Messaging content type ID'),
        tone: z.string().describe('Tone'),
        title: z.string().describe('Deliverable title'),
        brief: z.string().describe('Deliverable brief'),
        publishAt: z.string().describe('Publish datetime'),
        agent: z.string().optional().describe('Optional prep agent; defaults to Plan agent'),
        prepStartAt: z.string().optional().describe('Optional explicit prep start datetime'),
        prepStartAtOverride: z.string().optional().describe('Optional prep start override datetime'),
        draft: z.object({}).passthrough().optional().describe('Optional draft fields'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.planId || !params.channel || !params.contentType || !params.tone || !params.title || !params.brief || !params.publishAt) {
          return { ok: false, error: 'planId, channel, contentType, tone, title, brief, and publishAt required' }
        }
        const plan = contentStore.getPlan(params.planId as string)
        if (!plan) return { ok: false, error: 'Plan not found' }
        try {
          const contentType = params.contentType as string
          const publishAt = params.publishAt as string
          const agent = (params.agent as string | undefined) ?? plan.agent
          const deliverable = contentStore.createDeliverable({
            planId: plan.id,
            channel: params.channel as string,
            contentType,
            tone: params.tone as ContentTone,
            agent,
            title: params.title as string,
            brief: params.brief as string,
            publishAt,
            prepStartAt: (params.prepStartAt as string | undefined) ?? derivePrepStartAt(ctx, publishAt, contentType),
            prepStartAtOverride: params.prepStartAtOverride as string | undefined,
            status: 'proposed',
            draft: parseDraft(params.draft),
          })
          recomputeLinkedPlan(contentStore, plan.id)
          ctx.activity.audit('deliverable.proposed', agent, { deliverableId: deliverable.id, planId: plan.id })
          ctx.activity.log(agent, `Proposed content Deliverable "${deliverable.title}"`)
          return { ok: true, deliverable }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_list',
      label: 'Listed content deliverables',
      description: 'List content Deliverables with optional filters',
      parameters: {
        planId: z.union([z.string(), z.null()]).optional().describe('Filter by Plan ID; null returns Quick Posts'),
        status: z.string().optional().describe('Filter by Deliverable status'),
        channel: z.string().optional().describe('Filter by channel'),
        publishAfter: z.string().optional().describe('Filter by publishAt at or after this date'),
        publishBefore: z.string().optional().describe('Filter by publishAt at or before this date'),
      },
      handler: async (params: Record<string, unknown>) => {
        let deliverables = contentStore.listDeliverables()
        const planId = parseNullablePlanId(params.planId)
        if (planId !== undefined) deliverables = deliverables.filter(deliverable => deliverable.planId === planId)
        if (params.status) deliverables = deliverables.filter(deliverable => deliverable.status === params.status)
        if (params.channel) deliverables = deliverables.filter(deliverable => deliverable.channel === params.channel)
        if (params.publishAfter) deliverables = deliverables.filter(deliverable => Date.parse(deliverable.publishAt) >= Date.parse(params.publishAfter as string))
        if (params.publishBefore) deliverables = deliverables.filter(deliverable => Date.parse(deliverable.publishAt) <= Date.parse(params.publishBefore as string))
        return { ok: true, count: deliverables.length, deliverables }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_get',
      label: 'Read content deliverable',
      description: 'Get a content Deliverable',
      parameters: {
        deliverableId: z.string().describe('Deliverable ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.deliverableId) return { ok: false, error: 'deliverableId required' }
        const deliverable = contentStore.getDeliverable(params.deliverableId as string)
        if (!deliverable) return { ok: false, error: 'Deliverable not found' }
        return { ok: true, deliverable }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_create',
      label: 'Created content deliverable',
      activityDuplicate: true,
      description: 'Create a content Deliverable. Omit planId or pass null for a Quick Post.',
      parameters: {
        planId: z.union([z.string(), z.null()]).optional().describe('Optional Plan ID; null creates a Quick Post'),
        channel: z.string().describe('Runtime channel ID'),
        contentType: z.string().describe('Messaging content type ID'),
        tone: z.string().describe('Tone'),
        agent: z.string().describe('Prep agent'),
        title: z.string().describe('Deliverable title'),
        brief: z.string().describe('Deliverable brief'),
        publishAt: z.string().describe('Publish datetime'),
        prepStartAt: z.string().optional().describe('Optional explicit prep start datetime'),
        prepStartAtOverride: z.string().optional().describe('Optional prep start override datetime'),
        status: z.string().optional().describe('Optional initial status; defaults to planned'),
        draft: z.object({}).passthrough().optional().describe('Optional draft fields'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.title || !params.brief || !params.channel || !params.contentType || !params.tone || !params.agent || !params.publishAt) {
          return { ok: false, error: 'title, brief, channel, contentType, tone, agent, and publishAt required' }
        }
        const planId = parseNullablePlanId(params.planId) ?? null
        if (planId && !contentStore.getPlan(planId)) return { ok: false, error: 'Plan not found' }
        try {
          const contentType = params.contentType as string
          const publishAt = params.publishAt as string
          const deliverable = contentStore.createDeliverable({
            planId,
            channel: params.channel as string,
            contentType,
            tone: params.tone as ContentTone,
            agent: params.agent as string,
            title: params.title as string,
            brief: params.brief as string,
            publishAt,
            prepStartAt: (params.prepStartAt as string | undefined) ?? derivePrepStartAt(ctx, publishAt, contentType),
            prepStartAtOverride: params.prepStartAtOverride as string | undefined,
            status: (params.status as DeliverableStatus | undefined) ?? 'planned',
            draft: parseDraft(params.draft),
          })
          recomputeLinkedPlan(contentStore, planId)
          ctx.activity.audit('deliverable.created', params.agent as string, { deliverableId: deliverable.id, planId })
          return { ok: true, deliverable }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_update',
      label: 'Updated content deliverable',
      activityDuplicate: true,
      description: 'Update a content Deliverable. Draft fields are deep-merged.',
      parameters: {
        deliverableId: z.string().describe('Deliverable ID (required)'),
        planId: z.union([z.string(), z.null()]).optional().describe('Optional Plan ID; null makes it a Quick Post'),
        channel: z.string().optional().describe('Runtime channel ID'),
        contentType: z.string().optional().describe('Messaging content type ID'),
        tone: z.string().optional().describe('Tone'),
        agent: z.string().optional().describe('Prep agent'),
        title: z.string().optional().describe('Deliverable title'),
        brief: z.string().optional().describe('Deliverable brief'),
        publishAt: z.string().optional().describe('Publish datetime'),
        prepStartAt: z.string().optional().describe('Optional explicit prep start datetime'),
        prepStartAtOverride: z.string().optional().describe('Optional prep start override datetime'),
        status: z.string().optional().describe('Deliverable status'),
        rejectionNote: z.string().optional().describe('Optional rejection note'),
        draft: z.object({}).passthrough().optional().describe('Draft fields to deep-merge'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.deliverableId) return { ok: false, error: 'deliverableId required' }
        const id = params.deliverableId as string
        const existing = contentStore.getDeliverable(id)
        if (!existing) return { ok: false, error: 'Deliverable not found' }
        const planId = parseNullablePlanId(params.planId)
        if (planId && !contentStore.getPlan(planId)) return { ok: false, error: 'Plan not found' }
        const contentType = params.contentType as string | undefined
        const publishAt = params.publishAt as string | undefined
        const shouldDerivePrepStartAt = !params.prepStartAt && (contentType || publishAt)
        try {
          const deliverable = contentStore.updateDeliverable(id, {
            planId,
            channel: params.channel as string | undefined,
            contentType,
            tone: params.tone as ContentTone | undefined,
            agent: params.agent as string | undefined,
            title: params.title as string | undefined,
            brief: params.brief as string | undefined,
            publishAt,
            prepStartAt: (params.prepStartAt as string | undefined)
              ?? (shouldDerivePrepStartAt ? derivePrepStartAt(ctx, publishAt ?? existing.publishAt, contentType ?? existing.contentType) : undefined),
            prepStartAtOverride: params.prepStartAtOverride as string | undefined,
            status: params.status as DeliverableStatus | undefined,
            draft: parseDraft(params.draft),
            rejectionNote: params.rejectionNote as string | undefined,
          })
          recomputeLinkedPlan(contentStore, existing.planId)
          if (deliverable.planId !== existing.planId) recomputeLinkedPlan(contentStore, deliverable.planId)
          ctx.activity.audit('deliverable.updated', 'system', { deliverableId: id, planId: deliverable.planId })
          return { ok: true, deliverable }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_ready_for_review',
      label: 'Marked content deliverable ready for review',
      activityDuplicate: true,
      description: 'Signal that a bare-task Deliverable draft is ready for user review or auto-approval.',
      parameters: {
        deliverableId: z.string().describe('Deliverable ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.deliverableId) return { ok: false, error: 'deliverableId required' }
        const result = await markDeliverableReadyForReview(contentStore, ctx, ctx.getSettings<MessagingSettings>(), params.deliverableId as string)
        return result.ok ? { ok: true, deliverable: result.deliverable } : { ok: false, error: result.error, status: result.status, deliverable: result.deliverable }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_approve',
      label: 'Approved content deliverable',
      activityDuplicate: true,
      description: 'Approve a Deliverable after review.',
      parameters: {
        deliverableId: z.string().describe('Deliverable ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.deliverableId) return { ok: false, error: 'deliverableId required' }
        const result = await approveDeliverable(contentStore, ctx, ctx.getSettings<MessagingSettings>(), params.deliverableId as string)
        return result.ok ? { ok: true, deliverable: result.deliverable } : { ok: false, error: result.error, status: result.status, deliverable: result.deliverable }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_deliverable_reject',
      label: 'Rejected content deliverable',
      activityDuplicate: true,
      description: 'Request changes for a Deliverable after review.',
      parameters: {
        deliverableId: z.string().describe('Deliverable ID (required)'),
        note: z.string().optional().describe('Review note for the prep agent'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.deliverableId) return { ok: false, error: 'deliverableId required' }
        const result = await rejectDeliverable(contentStore, ctx, params.deliverableId as string, (params.note as string | undefined) ?? '')
        return result.ok ? { ok: true, deliverable: result.deliverable } : { ok: false, error: result.error, status: result.status, deliverable: result.deliverable }
      },
    })

    // ── Session Exec Tools (agent-facing) ─────────────────────────────

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_list',
      label: 'Listed brainstorm sessions',
      description: 'List planning sessions with optional filters',
      parameters: {
        status: z.string().optional().describe('Filter by status (active, archived)'),
        agentId: z.string().optional().describe('Filter by agent ID'),
      },
      handler: async (params: Record<string, unknown>) => {
        const sessions = listBrainstormSessionSummaries(contentStore, {
          status: params.status as string | undefined,
          agentId: params.agentId as string | undefined,
        })
        return { ok: true, count: sessions.length, sessions }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_get',
      label: 'Read brainstorm session',
      description: 'Get a planning session with full message history and proposals',
      parameters: {
        sessionId: z.string().describe('Session ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.sessionId) return { ok: false, error: 'sessionId required' }
        const session = contentStore.getBrainstormSession(params.sessionId as string)
        if (!session) return { ok: false, error: 'Session not found' }
        return { ok: true, session }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_create',
      label: 'Created brainstorm session',
      activityDuplicate: true,
      description: 'Create a new planning session for an agent',
      parameters: {
        agentId: z.string().describe('Agent ID (required)'),
          title: z.string().optional().describe('Session title'),
          scope: z.string().optional().describe('Optional brainstorm scope'),
        },
      handler: async (params: Record<string, unknown>) => {
        if (!params.agentId) return { ok: false, error: 'agentId required' }
        if (!(await validateAgentId(ctx, params.agentId as string))) return { ok: false, error: 'invalid agentId' }
        const session = contentStore.createBrainstormSession({
          agentId: params.agentId as string,
          title: (params.title as string | undefined) || 'New brainstorm session',
          scope: params.scope as string | undefined,
        })
        ctx.activity.audit('session.created', params.agentId as string, { sessionId: session.id })
        return { ok: true, session }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_update',
      label: 'Updated brainstorm session',
      description: 'Update a planning session title or status',
      parameters: {
        sessionId: z.string().describe('Session ID (required)'),
        title: z.string().optional().describe('New title'),
        status: z.string().optional().describe('New status (active, archived)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.sessionId) return { ok: false, error: 'sessionId required' }
        try {
          const session = contentStore.updateBrainstormSession(params.sessionId as string, {
            title: params.title as string | undefined,
            status: params.status as BrainstormSession['status'] | undefined,
          })
          return { ok: true, session }
        } catch (e: unknown) {
          return { ok: false, error: (e as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_delete',
      label: 'Deleted brainstorm session',
      activityDuplicate: true,
      description: 'Delete a planning session and optionally the Plans prepared from it.',
      parameters: {
        sessionId: z.string().describe('Session ID (required)'),
        deleteCreatedPlans: z.boolean().optional().describe('Delete Plans created from the session; defaults to true'),
        deleteLinkedTasks: z.boolean().optional().describe('Delete linked board tasks; defaults to true'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.sessionId) return { ok: false, error: 'sessionId required' }
        const session = contentStore.getBrainstormSession(params.sessionId as string)
        if (!session) return { ok: false, error: 'Session not found' }
        const deletedPlanIds: string[] = []
        const deletedTaskIds: string[] = []
        if (params.deleteCreatedPlans !== false) {
          const planIds = new Set([
            ...session.createdAtPlanIds,
            ...contentStore.listPlans()
              .filter((plan) => plan.sourceSessionId === session.id)
              .map((plan) => plan.id),
          ])
          for (const planId of planIds) {
            const result = await deletePlanAndLinkedWork(ctx, contentStore, planId, {
              deleteLinkedTasks: params.deleteLinkedTasks as boolean | undefined,
            })
            if (result.deleted) deletedPlanIds.push(planId)
            deletedTaskIds.push(...result.taskIds)
          }
        }
        contentStore.deleteBrainstormSession(params.sessionId as string)
        ctx.activity.audit('session.deleted', 'system', {
          sessionId: params.sessionId,
          deletedPlanIds,
          deletedTaskIds,
        })
        return { ok: true, planIds: deletedPlanIds, taskIds: deletedTaskIds }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_message',
      label: 'Sent brainstorm message',
      description: 'Send a message in a planning session (non-streaming, returns full response)',
      parameters: {
        sessionId: z.string().describe('Session ID (required)'),
        message: z.string().describe('User message content (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.sessionId || !params.message) return { ok: false, error: 'sessionId and message required' }
        const session = contentStore.getBrainstormSession(params.sessionId as string)
        if (!session) return { ok: false, error: 'Session not found' }
        if (session.status === 'archived') return { ok: false, error: 'Session is archived' }

        const userMsg = appendBrainstormMessage(contentStore, params.sessionId as string, {
          role: 'user',
          content: params.message as string,
        })

        // Non-streaming: call runtime synchronously and collect full response.
        // Durable history is held by the runtime adapter through the stable threadId.
        const promptOptions = await resolvePromptOptions(ctx, session.agentId)
        const messages = buildMessages(session, params.message as string, promptOptions)
        const sessionKey = brainstormThreadId('messaging', params.sessionId as string, session.agentId)

        let fullContent: string
        try {
          fullContent = await sendRuntimeChatCompletion(ctx, {
            messages,
            agentId: session.agentId,
            sessionKey,
          })
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }

        const proposals: unknown[] = []
        const blockRegex = /```json\s*([\s\S]*?)\s*```/g
        let match: RegExpExecArray | null
        while ((match = blockRegex.exec(fullContent)) !== null) {
          try {
            const parsed = JSON.parse(match[1])
            proposals.push(...(Array.isArray(parsed) ? parsed : [parsed]))
          } catch { /* ignore */ }
        }

        const cleanContent = fullContent.replace(/```json[\s\S]*?```/g, '').trim()
        const assistantMsg = appendBrainstormMessage(contentStore, params.sessionId as string, {
          role: 'assistant',
          content: cleanContent,
        })

        let savedProposals: unknown[] = []
        if (proposals.length > 0) {
          savedProposals = upsertBrainstormProposals(contentStore, params.sessionId as string, assistantMsg.id, proposals)
        }

        return {
          ok: true,
          response: cleanContent,
          messageId: assistantMsg.id,
          userMessageId: userMsg.id,
          proposals: savedProposals,
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_proposal_update',
      label: 'Updated brainstorm proposal',
      description: 'Update a proposal status or fields (approve, reject, edit)',
      parameters: {
        sessionId: z.string().describe('Session ID (required)'),
        proposalId: z.string().describe('Proposal ID (required)'),
        status: z.string().optional().describe('New status (proposed, approved, rejected, revised)'),
        title: z.string().optional().describe('Updated title'),
        brief: z.string().optional().describe('Updated brief'),
        targetDate: z.string().optional().describe('Updated Plan target date'),
        suggestedChannels: z.array(z.string()).optional().describe('Updated suggested channels'),
        rejectionNote: z.string().optional().describe('Note explaining rejection'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.sessionId || !params.proposalId) return { ok: false, error: 'sessionId and proposalId required' }
        try {
          const proposal = updateBrainstormProposal(contentStore, params.sessionId as string, params.proposalId as string, {
            status: params.status as ProposalStatus | undefined,
            title: params.title as string | undefined,
            brief: params.brief as string | undefined,
            targetDate: params.targetDate as string | undefined,
            suggestedChannels: params.suggestedChannels as string[] | undefined,
            rejectionNote: params.rejectionNote as string | undefined,
          })
          return { ok: true, proposal }
        } catch (e: unknown) {
          return { ok: false, error: (e as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_messaging_session_materialize',
      label: 'Prepared Plans from brainstorm proposals',
      activityDuplicate: true,
      description: 'Prepare Plans from accepted brainstorm proposals',
      parameters: {
        sessionId: z.string().describe('Session ID (required)'),
      },
      handler: async (params: Record<string, unknown>) => {
        if (!params.sessionId) return { ok: false, error: 'sessionId required' }
        const session = contentStore.getBrainstormSession(params.sessionId as string)
        if (!session) return { ok: false, error: 'Session not found' }
        const result = materializeApprovedProposals(session, contentStore)
        contentStore.updateBrainstormSession(session.id, {
          proposals: session.proposals,
          createdAtPlanIds: session.createdAtPlanIds,
        })
        ctx.activity.audit('session.materialized', 'system', { sessionId: params.sessionId, planIds: result.planIds })
        return { ok: true, ...result }
      },
    })

    ctx.watchFiles([
      ctx.storage.searchPath?.(SESSION_FILE_PATTERN) ?? SESSION_FILE_PATTERN,
    ])
    log.info('Messaging plugin activated')
  },

  onReady() {
    log.info('Ready')
  },

  onShutdown() {
    log.info('Messaging plugin shutting down')
  },
}

export default messagingPlugin
