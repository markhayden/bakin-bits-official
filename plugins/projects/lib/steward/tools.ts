/**
 * Steward tools (D24, D24a, D25): what a check-in task calls to report back
 * and to ask the user. Every call proves steward identity — the `taskId`
 * from its task prompt must be the project's OPEN steward task — and its
 * rows are attributed to that task's frozen assignee, not the current lead.
 * Rows land through the turn engine's out-of-turn append, so they never
 * splice into a running brainstorm turn.
 */
import { z } from 'zod'
import type { ConversationTurnRow, ConversationTurnService, PluginContext } from '@makinbakin/sdk/types'
import { validateBakinQuestionInput, QUESTION_LIMITS } from '@makinbakin/sdk/utils'
import type { ProjectRepository } from '../parser'
import type { Project } from '../../types'
import { isStewardTask } from './digest'
import type { InputGate } from './input-gate'
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
  return async function resolveSteward(projectId: unknown, taskId: unknown): Promise<IdentityResult> {
    const project = typeof projectId === 'string' ? repo.readProject(projectId) : null
    if (!project) return { ok: false, error: `Project not found: ${String(projectId)}`, code: 'not_found' }
    const open = project.steward?.openTaskId
    const task = typeof taskId === 'string' && taskId === open ? await ctx.tasks.get(taskId) : null
    if (task && isStewardTask(task, project.id)) {
      return { ok: true, identity: { project, taskId: task.id, agentId: project.steward?.frozen?.assignee ?? task.agent ?? project.owner } }
    }
    // Not the open check-in: from inside the project's own conversation the
    // right tool is ask_user; anywhere else the caller is simply not the steward.
    if (turns.isInFlight(project.id)) {
      return { ok: false, error: 'This is the project conversation — ask the user with bakin_exec_ask_user instead.', code: 'use_ask_user' }
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
    handler: async (params: Record<string, unknown>) => {
      const steward = await resolveSteward(params.projectId, params.taskId)
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
    handler: async (params: Record<string, unknown>) => {
      const steward = await resolveSteward(params.projectId, params.taskId)
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
      // The gate first: the very next user message (even one racing a queued
      // card) is this question's reply.
      await gate.open(project.id, {
        kind: 'input',
        questionId: question.id,
        question: question.question,
        options: question.options.map(option => option.label),
        ...(context ? { context } : {}),
        since: new Date().toISOString(),
      })
      const status = await append(project.id, [{
        kind: 'tool',
        ts: new Date().toISOString(),
        turnId: `steward:${taskId}`,
        agentId,
        toolName: 'bakin_exec_projects_request_input',
        status: 'completed',
        summary: question.question,
        metadata: { bakinQuestion: question },
      }], { agentId, preview: question.question })
      ctx.events.emit('projects.changed', { projectId: project.id, action: 'steward.waiting' })
      ctx.activity.audit('steward.request_input', agentId, { projectId: project.id, taskId, questionId: question.id })
      return { ok: true, questionId: question.id, status, message: 'Posted. Finish this check-in now — the user\'s reply starts the next conversation turn.' }
    },
  })
}
