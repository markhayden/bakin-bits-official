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

  /**
   * Move a task. A task that is gone, or already there, is fine; any other
   * failure THROWS — the caller's approval stays pending and a retry
   * converges (every effect here is idempotent).
   */
  async function moveTask(taskId: string | undefined, column: Task['column']): Promise<void> {
    if (!taskId) return
    const task = await ctx.tasks.get(taskId)
    if (task && task.column !== column) await ctx.tasks.move(taskId, column)
  }

  /** A note in the project conversation, on the asking check-in's turn and in its voice. */
  async function note(project: Project, gate: ProjectGateState | undefined, content: string): Promise<void> {
    const agentId = gate?.stewardAgentId ?? project.owner
    const result = await turns.appendExternal(turnCtx, project.id, [{
      kind: 'assistant',
      ts: new Date().toISOString(),
      ...(gate?.stewardTaskId ? { turnId: `steward:${gate.stewardTaskId}` } : {}),
      agentId,
      content,
    }], { agentId, preview: content })
    result.written.catch(err => log.warn('queued sign-off note failed to persist', { projectId: project.id, err }))
  }

  /**
   * End the loop for a project that completed or was archived: every other
   * pending sign-off → cancelled; open steward task → done (when it anchors
   * the resolving completion) or archived; input gate cleared. Failures
   * throw BEFORE the bookkeeping is cleared, so a retry converges.
   */
  async function cleanup(projectId: string, opts: { resolvingApprovalId?: string; reason: string }): Promise<void> {
    for (const approval of ctx.approvals.listPending({ entityId: projectId })) {
      if (approval.approvalId === opts.resolvingApprovalId) continue
      await ctx.approvals.cancel(approval.approvalId, opts.reason)
    }
    const openTaskId = repo.readProject(projectId)?.steward?.openTaskId
    const resolvingAnchor = opts.resolvingApprovalId ? ctx.approvals.get(opts.resolvingApprovalId)?.taskId : undefined
    if (openTaskId) {
      const task = await ctx.tasks.get(openTaskId)
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

  /**
   * The decision applies only to the CURRENT, still-pending generation —
   * the host does not ask ownerState at resolve time, so the gate fences it.
   */
  function currentGate(approval: PluginApproval): { project: Project; key: string; gate: ProjectGateState } {
    const parsed = parseGateApprovalId(approval.approvalId)
    const project = parsed ? repo.readProject(parsed.projectId) : null
    if (!parsed || !project) throw ctx.approvals.refusal('This project no longer exists.', 409)
    const key = gateKey(parsed.gateKind, parsed.subject)
    const gate = project.gates?.[key]
    if (gate?.approvalId !== approval.approvalId || gate.state !== 'pending') {
      throw ctx.approvals.refusal('This sign-off was replaced by a newer request.', 409)
    }
    return { project, key, gate }
  }

  async function resolveComplete(approval: PluginApproval, decision: PluginApprovalDecision): Promise<void> {
    const { project, key, gate } = currentGate(approval)
    if (decision.option === 'approve') {
      // A retry after a partial failure finds the project already completed
      // by THIS approval (its gate is still pending): resume, don't refuse.
      if (project.status === 'active') await projectService.updateProject(project.id, { status: 'completed' }, { kind: 'user' })
      else if (project.status !== 'completed') throw ctx.approvals.refusal('This project is no longer active.', 409)
      await moveTask(approval.taskId, 'done')
      await cleanup(project.id, { resolvingApprovalId: approval.approvalId, reason: 'Project completed' })
      await writeGate(project.id, key, approval.approvalId, 'approved')
      ctx.activity.audit('steward.completed', 'system', { projectId: project.id, approvalId: approval.approvalId, decidedBy: decision.decidedBy })
      return
    }
    if (project.status !== 'active') throw ctx.approvals.refusal('This project is no longer active.', 409)
    await moveTask(approval.taskId, 'done')
    await note(project, gate, `You held off on completing the project${decision.comment ? `: “${decision.comment}”` : '.'} I'll pick it back up at the next check-in.`)
    // Last: until every effect landed, the gate (and the approval) stay pending.
    await writeGate(project.id, key, approval.approvalId, 'rejected')
    changed(project.id)
  }

  async function resolveSignoff(approval: PluginApproval, decision: PluginApprovalDecision): Promise<void> {
    const { project, key, gate } = currentGate(approval)
    if (project.status !== 'active') throw ctx.approvals.refusal('This project is no longer active.', 409)
    const subject = parseGateApprovalId(approval.approvalId)!.subject
    const deliverable = await ctx.tasks.get(subject)
    if (decision.option === 'approve') {
      await moveTask(subject, 'done')
    } else {
      const reason = decision.comment?.trim() || 'No reason given.'
      const declined = `Sign-off declined: ${reason}`
      // Idempotent on retry: the reason lands once.
      if (deliverable && !deliverable.description?.includes(declined)) {
        await ctx.tasks.appendLog(subject, { timestamp: new Date().toISOString(), author: 'operator', message: declined })
        await ctx.tasks.update(subject, {
          column: 'todo',
          description: [deliverable.description?.trim(), declined].filter(Boolean).join('\n\n'),
        })
      } else if (deliverable) {
        await moveTask(subject, 'todo')
      }
      await note(project, gate, `You sent “${deliverable?.title ?? subject}” back: “${reason}”`)
    }
    // The check-in that asked is over once the decision is made.
    await moveTask(gate.stewardTaskId, 'done')
    await writeGate(project.id, key, approval.approvalId, decision.option === 'approve' ? 'approved' : 'rejected')
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
      handler: async (params: Record<string, unknown>, agent?: string) => {
        const steward = await resolveSteward(params.projectId, params.taskId, agent)
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
        /** A request that would return an existing record: pending, or a deliverable already signed off and done. */
        const reuse = (prior: ProjectGateState | undefined) => prior?.state === 'pending'
          || (prior?.state === 'approved' && gateKind === 'signoff' && deliverable?.column === 'done')

        const known = repo.readProject(project.id)?.gates?.[key]
        if (reuse(known)) return { ok: true, approvalId: known!.approvalId, state: known!.state, message: 'Already asked. Finish this check-in now.' }
        // The board's Review column carries the "Needs approval" signal —
        // moved BEFORE the approval exists, so a fast decision can never be
        // undone by a late move back to review.
        try {
          await moveTask(taskId, 'review')
          if (gateKind === 'signoff') await moveTask(subject, 'review')
        } catch (err) {
          return { ok: false, error: `Could not move the task to review: ${err instanceof Error ? err.message : String(err)}`, code: 'board_unavailable' }
        }

        const outcome = await withProjectLock(() => {
          const current = repo.readProject(project.id)
          if (!current) return { error: 'not_found' as const }
          const prior = current.gates?.[key]
          if (reuse(prior)) return { approvalId: prior!.approvalId, state: prior!.state, created: false }
          // Rejected, cancelled, or approved in an earlier lifecycle (a
          // reopened project, a reworked deliverable): a new generation.
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
          current.gates = { ...current.gates, [key]: { approvalId, generation, state: 'pending', stewardTaskId: taskId, stewardAgentId: steward.identity.agentId } }
          repo.writeProject(current)
          return { approvalId, state: 'pending' as const, created: true }
        })
        if ('error' in outcome) return { ok: false, error: `Project not found: ${project.id}`, code: 'not_found' }
        if (outcome.created) {
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
