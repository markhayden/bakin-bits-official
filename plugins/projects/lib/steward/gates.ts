/**
 * Sign-off gates (D26) and completion cleanup (D28).
 *
 * The steward asks; only the operator decides — through Bakin's one approval
 * primitive (`ctx.approvals`), which shows the request on the board's Review
 * column, in attention, and on channels. Approval ids are deterministic:
 * `projects:<projectId>:<gateKind>:<subject>:<generation>`; at most one is
 * pending per gate, a re-request while pending returns it, and a request
 * after a rejection bumps the generation.
 *
 *   complete — "every step is done; complete the project?" Approve ⇒ the
 *              project completes (cleanup below) and the check-in task is
 *              done; reject ⇒ the reason goes to the conversation, the loop
 *              resumes.
 *   signoff  — "is this deliverable right?" Approve ⇒ the deliverable is
 *              done; reject ⇒ the reason lands on the task (log +
 *              description) and in the conversation, and the task goes back
 *              to todo.
 *
 * Cleanup when a project completes (manual or approved) is idempotent and
 * NEVER cancels the approval that is resolving: core calls onResolve before
 * it persists the decision, and cancelling it would fail core's
 * compare-and-set.
 */
import { z } from 'zod'
import type { ConversationTurnService, PluginApproval, PluginApprovalDecision, PluginContext, Task } from '@makinbakin/sdk/types'
import type { ProjectRepository } from '../parser'
import { withProjectLock, type ProjectService } from '../project-service'
import type { Project, ProjectGateState } from '../../types'
import { isStewardTask } from './digest'
import { createStewardIdentity } from './tools'

const log = {
  warn: (...args: unknown[]) => console.warn('[projects:steward]', ...args),
}

export const GATE_KINDS = ['complete', 'signoff'] as const
export type GateKind = (typeof GATE_KINDS)[number]

const SUMMARY_MAX = 1_000

export function gateKey(gateKind: GateKind, subject: string): string {
  return `${gateKind}:${subject}`
}

export function gateApprovalId(projectId: string, gateKind: GateKind, subject: string, generation: number): string {
  return `projects:${projectId}:${gateKind}:${subject}:${generation}`
}

/** `projects:<projectId>:<gateKind>:<subject>:<generation>` → its parts, or null. */
export function parseGateApprovalId(approvalId: string): { projectId: string; gateKind: GateKind; subject: string; generation: number } | null {
  const match = /^projects:([^:]+):(complete|signoff):([^:]+):(\d+)$/.exec(approvalId)
  if (!match) return null
  return { projectId: match[1]!, gateKind: match[2] as GateKind, subject: match[3]!, generation: Number(match[4]) }
}

export interface StewardGatesDeps {
  ctx: PluginContext
  repo: ProjectRepository
  turns: ConversationTurnService
  projectService: Pick<ProjectService, 'updateProject'>
}

export function createStewardGates({ ctx, repo, turns, projectService }: StewardGatesDeps) {
  const turnCtx = { runtime: ctx.runtime, events: ctx.events }
  const changed = (projectId: string) => ctx.events.emit('projects.changed', { projectId, action: 'steward.gate' })

  function writeGate(projectId: string, key: string, approvalId: string, state: ProjectGateState['state']): Promise<boolean> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      const gate = project?.gates?.[key]
      if (!project || gate?.approvalId !== approvalId || gate.state === state) return false
      gate.state = state
      repo.writeProject(project)
      return true
    })
  }

  /** Move a task, tolerating one that is already there or gone. */
  async function moveTask(taskId: string | undefined, column: Task['column']): Promise<void> {
    if (!taskId) return
    try {
      const task = await ctx.tasks.get(taskId)
      if (task && task.column !== column) await ctx.tasks.move(taskId, column)
    } catch (err) {
      log.warn('could not move task', { taskId, column, err })
    }
  }

  /** A note in the project conversation, on the steward's own turn. */
  async function note(project: Project, stewardTaskId: string | undefined, content: string): Promise<void> {
    const agentId = project.steward?.frozen?.assignee ?? project.owner
    const result = await turns.appendExternal(turnCtx, project.id, [{
      kind: 'assistant',
      ts: new Date().toISOString(),
      ...(stewardTaskId ? { turnId: `steward:${stewardTaskId}` } : {}),
      agentId,
      content,
    }], { agentId, preview: content })
    result.written.catch(err => log.warn('queued sign-off note failed to persist', { projectId: project.id, err }))
  }

  /**
   * End the loop for a project that completed or was archived: open steward
   * task → done (when it anchors the resolving completion) or archived;
   * every other pending sign-off → cancelled; input gate cleared.
   * Idempotent — a retry after a partial failure converges.
   */
  async function cleanup(projectId: string, opts: { resolvingApprovalId?: string; reason: string }): Promise<void> {
    for (const approval of ctx.approvals.listPending({ entityId: projectId })) {
      if (approval.approvalId === opts.resolvingApprovalId) continue
      await ctx.approvals.cancel(approval.approvalId, opts.reason)
    }
    const before = repo.readProject(projectId)
    const openTaskId = before?.steward?.openTaskId
    const resolvingAnchor = opts.resolvingApprovalId ? ctx.approvals.get(opts.resolvingApprovalId)?.taskId : undefined
    if (openTaskId) {
      const task = await ctx.tasks.get(openTaskId).catch(() => null)
      if (task && isStewardTask(task, projectId)) await moveTask(openTaskId, openTaskId === resolvingAnchor ? 'done' : 'archived')
    }
    await withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) return
      for (const [key, gate] of Object.entries(project.gates ?? {})) {
        if (gate.state === 'pending' && gate.approvalId !== opts.resolvingApprovalId) project.gates![key] = { ...gate, state: 'cancelled' }
      }
      if (project.steward) {
        const { openTaskId: _open, phase: _phase, frozen: _frozen, reservedAt: _reserved, fingerprint: _fp, ...kept } = project.steward
        project.steward = kept
      }
      delete project.waitingOn
      delete project.replyPending
      repo.writeProject(project)
    })
    changed(projectId)
  }

  async function ownerState(approval: PluginApproval): Promise<'live' | 'orphaned' | 'unknown'> {
    const parsed = parseGateApprovalId(approval.approvalId)
    if (!parsed) return 'orphaned'
    let project: Project | null
    try {
      project = repo.readProject(parsed.projectId)
    } catch {
      return 'unknown'
    }
    if (!project || project.status !== 'active') return 'orphaned'
    // A newer generation (or none) supersedes this one. A pending `complete`
    // whose anchor task is already done stays valid: the approval is the truth.
    return project.gates?.[gateKey(parsed.gateKind, parsed.subject)]?.approvalId === approval.approvalId ? 'live' : 'orphaned'
  }

  async function resolveComplete(approval: PluginApproval, decision: PluginApprovalDecision): Promise<void> {
    const parsed = parseGateApprovalId(approval.approvalId)!
    const project = repo.readProject(parsed.projectId)
    if (!project || project.status !== 'active') throw ctx.approvals.refusal('This project is no longer active.', 409)
    const key = gateKey('complete', parsed.subject)
    if (decision.option === 'approve') {
      await projectService.updateProject(project.id, { status: 'completed' }, { kind: 'user' })
      await moveTask(approval.taskId, 'done')
      await writeGate(project.id, key, approval.approvalId, 'approved')
      await cleanup(project.id, { resolvingApprovalId: approval.approvalId, reason: 'Project completed' })
      ctx.activity.audit('steward.completed', 'system', { projectId: project.id, approvalId: approval.approvalId, decidedBy: decision.decidedBy })
      return
    }
    await writeGate(project.id, key, approval.approvalId, 'rejected')
    await moveTask(approval.taskId, 'done')
    await note(project, approval.taskId, `You held off on completing the project${decision.comment ? `: “${decision.comment}”` : '.'} I'll pick it back up at the next check-in.`)
    changed(project.id)
  }

  async function resolveSignoff(approval: PluginApproval, decision: PluginApprovalDecision): Promise<void> {
    const parsed = parseGateApprovalId(approval.approvalId)!
    const project = repo.readProject(parsed.projectId)
    if (!project || project.status !== 'active') throw ctx.approvals.refusal('This project is no longer active.', 409)
    const key = gateKey('signoff', parsed.subject)
    const deliverable = await ctx.tasks.get(parsed.subject)
    // The check-in that ASKED — a later check-in may be open by now.
    const stewardTaskId = project.gates?.[key]?.stewardTaskId
    if (decision.option === 'approve') {
      await moveTask(parsed.subject, 'done')
    } else {
      const reason = decision.comment?.trim() || 'No reason given.'
      if (deliverable) {
        await ctx.tasks.appendLog(parsed.subject, { timestamp: new Date().toISOString(), author: 'operator', message: `Sign-off declined: ${reason}` })
        await ctx.tasks.update(parsed.subject, {
          column: 'todo',
          description: [deliverable.description?.trim(), `Sign-off declined: ${reason}`].filter(Boolean).join('\n\n'),
        })
      }
      await note(project, stewardTaskId, `You sent “${deliverable?.title ?? parsed.subject}” back: “${reason}”`)
    }
    await writeGate(project.id, key, approval.approvalId, decision.option === 'approve' ? 'approved' : 'rejected')
    // The check-in that asked is over once the decision is made.
    if (stewardTaskId) await moveTask(stewardTaskId, 'done')
    changed(project.id)
  }

  function registerGates(): void {
    ctx.approvals.registerGate('complete', { ownerState, onResolve: resolveComplete })
    ctx.approvals.registerGate('signoff', { ownerState, onResolve: resolveSignoff })
  }

  function registerTool(): void {
    const resolveSteward = createStewardIdentity({ ctx, repo, turns })
    ctx.registerExecTool({
      name: 'bakin_exec_projects_request_signoff',
      label: 'Requested a project sign-off',
      description: 'Ask the user to sign off during a project check-in: gateKind "complete" when every step is done (the user decides whether the project is complete), or "signoff" with subjectTaskId when a deliverable needs their approval. Only the user can decide; finish the check-in after asking.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        taskId: z.string().describe('Your check-in task id (from the task description)'),
        gateKind: z.enum(GATE_KINDS).describe('"complete" for the whole project, "signoff" for one deliverable'),
        subjectTaskId: z.string().optional().describe('The deliverable\'s board task id (required for "signoff")'),
        summary: z.string().describe('What the user is approving, and why it is ready'),
      },
      handler: async (params: Record<string, unknown>) => {
        const steward = await resolveSteward(params.projectId, params.taskId)
        if (!steward.ok) return { ok: false, error: steward.error, code: steward.code }
        const { project, taskId } = steward.identity
        const gateKind = params.gateKind
        if (gateKind !== 'complete' && gateKind !== 'signoff') return { ok: false, error: 'gateKind must be "complete" or "signoff"', code: 'invalid_request' }
        const summary = typeof params.summary === 'string' ? params.summary.trim().slice(0, SUMMARY_MAX) : ''
        if (!summary) return { ok: false, error: 'summary is required', code: 'invalid_request' }

        let subject = 'project'
        let deliverable: Task | null = null
        if (gateKind === 'signoff') {
          deliverable = typeof params.subjectTaskId === 'string' ? await ctx.tasks.get(params.subjectTaskId) : null
          if (!deliverable || deliverable.projectId !== project.id || isStewardTask(deliverable)) {
            return { ok: false, error: 'subjectTaskId must be one of this project\'s board tasks', code: 'invalid_subject' }
          }
          subject = deliverable.id
        }
        const anchor = gateKind === 'complete' ? taskId : subject
        const key = gateKey(gateKind, subject)

        const outcome = await withProjectLock(() => {
          const current = repo.readProject(project.id)
          if (!current) return { error: 'not_found' as const }
          const prior = current.gates?.[key]
          if (prior?.state === 'pending' || prior?.state === 'approved') return { approvalId: prior.approvalId, state: prior.state, created: false }
          const generation = (prior?.generation ?? 0) + 1
          const approvalId = gateApprovalId(project.id, gateKind, subject, generation)
          ctx.approvals.request({
            approvalId,
            gateKind,
            entityId: project.id,
            taskId: anchor,
            title: gateKind === 'complete' ? `Complete “${current.title}”?` : `Sign off “${deliverable!.title}”?`,
            summary,
          })
          current.gates = { ...current.gates, [key]: { approvalId, generation, state: 'pending', stewardTaskId: taskId } }
          repo.writeProject(current)
          return { approvalId, state: 'pending' as const, created: true }
        })
        if ('error' in outcome) return { ok: false, error: `Project not found: ${project.id}`, code: 'not_found' }
        if (outcome.created) {
          // The board's Review column carries the "Needs approval" signal.
          await moveTask(taskId, 'review')
          if (gateKind === 'signoff') await moveTask(subject, 'review')
          ctx.activity.audit('steward.request_signoff', steward.identity.agentId, { projectId: project.id, taskId, gateKind, approvalId: outcome.approvalId })
          changed(project.id)
        }
        return { ok: true, approvalId: outcome.approvalId, state: outcome.state, message: 'The user decides on the board. Finish this check-in now.' }
      },
    })
  }

  return { registerGates, registerTool, cleanup, ownerState }
}

export type StewardGates = ReturnType<typeof createStewardGates>
