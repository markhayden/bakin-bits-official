/**
 * Steward tools (D24, D24a, D25): what a check-in task calls to report back
 * and to ask the user. Every call proves steward identity as far as the host
 * lets a plugin: the `taskId` from its task prompt must be the project's
 * OPEN steward task, the calling agent must be that task's frozen assignee,
 * and the call is refused while that agent has a brainstorm turn running on
 * the project (the conversation asks with bakin_exec_ask_user). Tool calls
 * carry no session identity, so a call made by the same agent from another
 * session that knows the open task id cannot be told apart — the same
 * "declared, not verified" limit approvals document. Rows are attributed to
 * the frozen assignee and land through the turn engine's out-of-turn
 * append, so they never splice into a running brainstorm turn.
 */
import { z } from 'zod'
import type { ConversationTurnRow, ConversationTurnService, ExecToolResult, PluginContext } from '@makinbakin/sdk/types'
import { validateBakinQuestionInput, QUESTION_LIMITS } from '@makinbakin/sdk/utils'
import type { ProjectRepository } from '../parser'
import type { Project } from '../../types'
import { isStewardTask } from './digest'
import type { InputGate } from './input-gate'
import { withAdmissionFence } from './admission'
import { capBytes } from './prompt'

const log = {
  warn: (...args: unknown[]) => console.warn('[projects:steward]', ...args),
}

export const STEWARD_CONTEXT_MAX_BYTES = 1_024
const SUMMARY_MAX = 500
const ACTION_MAX = 200
const MAX_ACTIONS = 12

export interface StewardIdentity {
  project: Project
  taskId: string
  /** Attribution: the reserved task's assignee (D24). */
  agentId: string
}

type IdentityResult = { ok: true; identity: StewardIdentity } | { ok: false; error: string; code: 'not_found' | 'not_steward' | 'use_ask_user' }

/** The invocation's agent, as the host passes it to an exec-tool handler. */
export type CallerAgent = string | undefined

export interface StewardToolDeps {
  ctx: PluginContext
  repo: ProjectRepository
  turns: ConversationTurnService
  gate: InputGate
}

export function mintStewardQuestionId(): string {
  return `q_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function createStewardIdentity({ ctx, repo, turns }: Pick<StewardToolDeps, 'ctx' | 'repo' | 'turns'>) {
  return async function resolveSteward(projectId: unknown, taskId: unknown, caller: CallerAgent): Promise<IdentityResult> {
    const project = typeof projectId === 'string' ? repo.readProject(projectId) : null
    if (!project) return { ok: false, error: `Project not found: ${String(projectId)}`, code: 'not_found' }
    // The project's own conversation asks with ask_user — checked FIRST, so
    // a brainstorm turn that learned the check-in's task id still cannot
    // speak as the steward.
    const brainstorm = turns.listInFlight().find(turn => turn.key === project.id)
    if (brainstorm && brainstorm.agentId === caller) {
      return { ok: false, error: 'This is the project conversation — ask the user with bakin_exec_ask_user instead.', code: 'use_ask_user' }
    }
    const open = project.steward?.openTaskId
    const task = typeof taskId === 'string' && taskId === open ? await ctx.tasks.get(taskId) : null
    const assignee = project.steward?.frozen?.assignee ?? task?.agent ?? project.owner
    if (task && isStewardTask(task, project.id) && caller === assignee) {
      return { ok: true, identity: { project, taskId: task.id, agentId: assignee } }
    }
    return { ok: false, error: 'Only the project\'s open check-in task can call this — pass the taskId from your check-in task.', code: 'not_steward' }
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function registerStewardTools({ ctx, repo, turns, gate }: StewardToolDeps): void {
  const resolveSteward = createStewardIdentity({ ctx, repo, turns })
  const turnCtx = { runtime: ctx.runtime, events: ctx.events }

  /** Append without awaiting `written` — a queued batch lands after the running brainstorm turn. */
  async function append(projectId: string, rows: ConversationTurnRow[], notice?: { agentId: string; preview: string }): Promise<'appended' | 'queued'> {
    const result = await turns.appendExternal(turnCtx, projectId, rows, notice)
    result.written.catch(err => log.warn('queued steward rows failed to persist', { projectId, err }))
    return result.status
  }

  ctx.registerExecTool({
    name: 'bakin_exec_projects_checkin',
    label: 'Checked in on a project',
    description: 'Report what this check-in did, in the project conversation. Call once at the end of a project check-in task with the taskId from that task.',
    parameters: {
      projectId: z.string().describe('Project ID'),
      taskId: z.string().describe('Your check-in task id (from the task description)'),
      summary: z.string().describe('One line: what you did or found'),
      actions: z.array(z.string()).optional().describe('Short list of the actions you took (sent steps to the board, reassigned a task, …)'),
    },
    handler: async (params: Record<string, unknown>, agent?: string) => {
      const steward = await resolveSteward(params.projectId, params.taskId, agent)
      if (!steward.ok) return { ok: false, error: steward.error, code: steward.code }
      const summary = typeof params.summary === 'string' ? clip(params.summary, SUMMARY_MAX) : ''
      if (!summary) return { ok: false, error: 'summary is required', code: 'invalid_request' }
      const actions = (Array.isArray(params.actions) ? params.actions : [])
        .filter((action): action is string => typeof action === 'string' && action.trim().length > 0)
        .slice(0, MAX_ACTIONS)
        .map(action => `- ${clip(action, ACTION_MAX)}`)
      const { project, taskId, agentId } = steward.identity
      const status = await append(project.id, [{
        kind: 'assistant',
        ts: new Date().toISOString(),
        turnId: `steward:${taskId}`,
        agentId,
        content: [`Checked in: ${summary}`, ...actions].join('\n'),
      }])
      ctx.activity.audit('steward.checkin', agentId, { projectId: project.id, taskId, actions: actions.length })
      return { ok: true, status }
    },
  })

  ctx.registerExecTool({
    name: 'bakin_exec_projects_request_input',
    label: 'Asked the user about a project',
    description: 'Ask the user ONE decision you cannot make yourself (scope, dropping steps, spend) during a project check-in. It appears as an answerable card in the project conversation; check-ins pause until they reply. Use the taskId from your check-in task, then finish the check-in.',
    parameters: {
      projectId: z.string().describe('Project ID'),
      taskId: z.string().describe('Your check-in task id (from the task description)'),
      question: z.string().describe(`The question (max ${QUESTION_LIMITS.question} chars)`),
      options: z.array(z.object({
        label: z.string().describe(`Short answer (max ${QUESTION_LIMITS.label} chars)`),
        description: z.string().optional().describe(`What it means (max ${QUESTION_LIMITS.description} chars)`),
      })).describe(`${QUESTION_LIMITS.minOptions}-${QUESTION_LIMITS.maxOptions} mutually exclusive options`),
      recommended: z.number().int().optional().describe('Index of the option you recommend'),
      allowOther: z.boolean().optional().describe('Offer a free-text answer (default true)'),
      context: z.string().optional().describe('Why you are asking — replayed to you with their reply (max 1 KB)'),
    },
    handler: async (params: Record<string, unknown>, agent?: string) => {
      const steward = await resolveSteward(params.projectId, params.taskId, agent)
      if (!steward.ok) return { ok: false, error: steward.error, code: steward.code }
      const input = validateBakinQuestionInput({
        question: params.question,
        options: params.options,
        ...(params.recommended !== undefined ? { recommended: params.recommended } : {}),
        ...(params.allowOther !== undefined ? { allowOther: params.allowOther } : {}),
      })
      if (!input.ok) return { ok: false, error: `Invalid question — ${input.error}`, code: 'invalid_question' }
      const { project, taskId, agentId } = steward.identity
      const question = { v: 1 as const, id: mintStewardQuestionId(), ...input.value }
      const context = typeof params.context === 'string' && params.context.trim()
        ? capBytes(params.context.trim(), STEWARD_CONTEXT_MAX_BYTES, 'context')
        : undefined
      // Gate + card under the admission fence: a reply being admitted right
      // now either already carried an earlier question or finishes before
      // this one exists (D25).
      type Posted = { error: ExecToolResult } | { status: 'appended' | 'queued' }
      const posted = await withAdmissionFence(project.id, async (): Promise<Posted> => {
        // The gate first: the very next user message (even one racing a queued
        // card) is this question's reply.
        const opened = await gate.open(project.id, {
          kind: 'input',
          questionId: question.id,
          question: question.question,
          options: question.options.map(option => option.label),
          ...(context ? { context } : {}),
          since: new Date().toISOString(),
        }, taskId)
        if (!opened) return { error: { ok: false, error: 'This check-in is no longer open on an active project.', code: 'not_steward' } }
        // An unseen question must never hold the project: if the card does not
        // land (now, or when its queued batch flushes), the gate goes with it.
        const withdraw = (err: unknown) => {
          log.warn('steward question failed to persist; withdrawing its gate', { projectId: project.id, err })
          return gate.withdraw(project.id, question.id)
        }
        let result: Awaited<ReturnType<typeof turns.appendExternal>>
        try {
          result = await turns.appendExternal(turnCtx, project.id, [{
            kind: 'tool',
            ts: new Date().toISOString(),
            turnId: `steward:${taskId}`,
            agentId,
            toolName: 'bakin_exec_projects_request_input',
            status: 'completed',
            summary: question.question,
            metadata: { bakinQuestion: question },
          }], { agentId, preview: question.question })
        } catch (err) {
          await withdraw(err)
          return { error: { ok: false, error: 'The question could not be posted. Try again.', code: 'append_failed' } }
        }
        result.written.catch(withdraw)
        const status = result.status
        return { status }
      })
      if ('error' in posted) return posted.error
      const { status } = posted
      ctx.events.emit('projects.changed', { projectId: project.id, action: 'steward.waiting' })
      ctx.activity.audit('steward.request_input', agentId, { projectId: project.id, taskId, questionId: question.id })
      return { ok: true, questionId: question.id, status, message: 'Posted. Finish this check-in now — the user\'s reply starts the next conversation turn.' }
    },
  })
}
