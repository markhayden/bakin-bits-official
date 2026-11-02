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
import type { ConversationTurnService, ExecToolResult, PluginApproval, PluginApprovalDecision, PluginContext, Task } from '@makinbakin/sdk/types'
import type { ProjectRepository } from '../parser'
import { withProjectLock, type ProjectService } from '../project-service'
import type { Project, ProjectGateState } from '../../types'
import { isStewardTask } from './digest'
import { serialized, withAdmissionFence } from './admission'
import { createStewardIdentity } from './tools'

function gateQueues(): Map<string, Promise<unknown>> {
  const g = globalThis as Record<string, unknown>
  if (!g.__bakinProjectGateQueues) g.__bakinProjectGateQueues = new Map<string, Promise<unknown>>()
  return g.__bakinProjectGateQueues as Map<string, Promise<unknown>>
}

const log = {
  warn: (...args: unknown[]) => console.warn('[projects steward]', ...args),
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

/**
 * Pending gates follow the host's record: a decision, cancellation or
 * expiry the plugin did not see (rehydration, a restart mid-resolve) lands
 * in frontmatter, so no project waits on an approval that is gone.
 */
export async function syncGateStates(ctx: PluginContext, repo: ProjectRepository, projectId: string): Promise<void> {
  const pending = Object.entries(repo.readProject(projectId)?.gates ?? {}).filter(([, gate]) => gate.state === 'pending')
  if (!pending.length) return
  const settled = new Map<string, ProjectGateState['state']>()
  for (const [key, gate] of pending) {
    const record = ctx.approvals.get(gate.approvalId)
    if (record?.status === 'pending') continue
    settled.set(key, record?.status === 'approved' || record?.status === 'rejected' ? record.status : 'cancelled')
  }
  if (!settled.size) return
  await withProjectLock(() => {
    const project = repo.readProject(projectId)
    if (!project?.gates) return
    for (const [key, state] of settled) {
      if (project.gates[key]?.state === 'pending') project.gates[key] = { ...project.gates[key]!, state }
    }
    repo.writeProject(project)
  })
}

export function createStewardGates({ ctx, repo, turns, projectService }: StewardGatesDeps) {
  const turnCtx = { runtime: ctx.runtime, events: ctx.events }
  const changed = (projectId: string) => ctx.events.emit('projects.changed', { projectId, action: 'steward.gate' })

  /**
   * ONE gate operation per project at a time — request, resolve and cleanup
   * serialize here, so a decision can never interleave with completion
   * cleanup or a late request. Held across task APIs; the global project
   * lock is only ever taken INSIDE it, never the other way round.
   */
  function withGateLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    // On globalThis (like the project lock): a hot reload keeps serializing
    // against operations the previous activation still has in flight.
    return serialized(gateQueues, projectId, fn)
  }

  /** Write the gate's terminal state (and anything riding with it) — last, after every effect landed. */
  function settleGate(projectId: string, key: string, approvalId: string, state: ProjectGateState['state'], extra?: (project: Project) => void): Promise<boolean> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      const gate = project?.gates?.[key]
      if (!project || gate?.approvalId !== approvalId) return false
      gate.state = state
      extra?.(project)
      repo.writeProject(project)
      return true
    })
  }

  const followUp = (project: Project) => { project.steward = { ...project.steward, runNext: 'decision' } }

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
   * End the loop for a project that completed, was archived or is being
   * deleted: every other STILL-PENDING sign-off → cancelled (a gate already
   * settled here is resolving on the host — cancelling it would fail that
   * decision); the open check-in → done when it anchors the resolving
   * completion, otherwise REMOVED (deleting a task is what aborts a running
   * dispatch turn); input gate and pending follow-ups cleared. Failures
   * throw BEFORE the bookkeeping is cleared, so a retry converges.
   */
  async function cleanupLocked(projectId: string, opts: { resolvingApprovalId?: string; reason: string }): Promise<void> {
    const gates = Object.values(repo.readProject(projectId)?.gates ?? {})
    for (const approval of ctx.approvals.listPending({ entityId: projectId })) {
      if (approval.approvalId === opts.resolvingApprovalId) continue
      const gate = gates.find(candidate => candidate.approvalId === approval.approvalId)
      if (gate && gate.state !== 'pending') continue
      await ctx.approvals.cancel(approval.approvalId, opts.reason)
    }
    const openTaskId = repo.readProject(projectId)?.steward?.openTaskId
    const resolvingAnchor = opts.resolvingApprovalId ? ctx.approvals.get(opts.resolvingApprovalId)?.taskId : undefined
    if (openTaskId) {
      const task = await ctx.tasks.get(openTaskId)
      if (task && isStewardTask(task, projectId)) {
        if (openTaskId === resolvingAnchor) await moveTask(openTaskId, 'done')
        else await ctx.tasks.remove(openTaskId)
      }
    }
    // Inside the admission fence: a question post waiting on it finds the
    // check-in already gone (gate.open re-checks), never re-opens a gate
    // this cleanup just cleared.
    await withAdmissionFence(projectId, () => withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) return
      for (const [key, gate] of Object.entries(project.gates ?? {})) {
        if (gate.state === 'pending' && gate.approvalId !== opts.resolvingApprovalId) project.gates![key] = { ...gate, state: 'cancelled' }
      }
      if (project.steward) {
        const { openTaskId: _open, phase: _phase, frozen: _frozen, reservedAt: _reserved, fingerprint: _fp, briefColumns: _brief, runNext: _next, completions: _done, ...kept } = project.steward
        project.steward = kept
      }
      delete project.waitingOn
      delete project.replyPending
      repo.writeProject(project)
    }))
    changed(projectId)
  }

  function cleanup(projectId: string, opts: { reason: string }): Promise<void> {
    return withGateLock(projectId, () => cleanupLocked(projectId, opts))
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
    // A newer generation (or none) supersedes this one.
    if (!project || project.gates?.[gateKey(parsed.gateKind, parsed.subject)]?.approvalId !== approval.approvalId) return 'orphaned'
    if (project.status === 'active') return 'live'
    // An approved completion that failed half-way (status already completed)
    // stays decidable, so the operator's retry resumes its cleanup.
    return project.status === 'completed' && parsed.gateKind === 'complete' ? 'live' : 'orphaned'
  }

  /**
   * The decision applies only to the CURRENT generation, still pending on
   * the host. A gate already settled to THIS decision is a replay (the
   * effects landed but the host's record write did not): a no-op, so the
   * host can commit it.
   */
  function currentGate(approval: PluginApproval, decision: PluginApprovalDecision): { project: Project; key: string; gate: ProjectGateState; replay: boolean } {
    const parsed = parseGateApprovalId(approval.approvalId)
    const project = parsed ? repo.readProject(parsed.projectId) : null
    if (!parsed || !project) throw ctx.approvals.refusal('This project no longer exists.', 409)
    if (ctx.approvals.get(approval.approvalId)?.status !== 'pending') throw ctx.approvals.refusal('This sign-off is no longer pending.', 409)
    const key = gateKey(parsed.gateKind, parsed.subject)
    const gate = project.gates?.[key]
    if (gate?.approvalId !== approval.approvalId) throw ctx.approvals.refusal('This sign-off was replaced by a newer request.', 409)
    if (gate.state === 'pending') return { project, key, gate, replay: false }
    if (gate.state === (decision.option === 'approve' ? 'approved' : 'rejected')) return { project, key, gate, replay: true }
    throw ctx.approvals.refusal('This sign-off was already decided.', 409)
  }

  function resolveComplete(approval: PluginApproval, decision: PluginApprovalDecision): Promise<void> {
    const projectId = parseGateApprovalId(approval.approvalId)?.projectId ?? ''
    return withGateLock(projectId, async () => {
      const { project, key, gate, replay } = currentGate(approval, decision)
      if (replay) return
      if (decision.option === 'approve') {
        // A retry after a partial failure finds the project already completed
        // by THIS approval (its gate is still pending): resume, don't refuse.
        if (project.status === 'active') await projectService.updateProject(project.id, { status: 'completed' }, { kind: 'user' })
        else if (project.status !== 'completed') throw ctx.approvals.refusal('This project is no longer active.', 409)
        await moveTask(approval.taskId, 'done')
        await cleanupLocked(project.id, { resolvingApprovalId: approval.approvalId, reason: 'Project completed' })
        await settleGate(project.id, key, approval.approvalId, 'approved')
        ctx.activity.audit('steward.completed', 'system', { projectId: project.id, approvalId: approval.approvalId, decidedBy: decision.decidedBy })
        return
      }
      if (project.status !== 'active') throw ctx.approvals.refusal('This project is no longer active.', 409)
      await moveTask(approval.taskId, 'done')
      await note(project, gate, `You held off on completing the project${decision.comment ? `: “${decision.comment}”` : '.'} I'll pick it back up at the next check-in.`)
      // Last: until every effect landed, the gate (and the approval) stay pending.
      await settleGate(project.id, key, approval.approvalId, 'rejected', followUp)
      changed(project.id)
    })
  }

  function resolveSignoff(approval: PluginApproval, decision: PluginApprovalDecision): Promise<void> {
    const projectId = parseGateApprovalId(approval.approvalId)?.projectId ?? ''
    return withGateLock(projectId, async () => {
      const { project, key, gate, replay } = currentGate(approval, decision)
      if (replay) return
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
      // The check-in that asked is over once the decision is made; the
      // decision itself earns the lead a follow-up look (runNext), so
      // finalizing that check-in never swallows it.
      await moveTask(gate.stewardTaskId, 'done')
      // Last, so a failed effect (the close above included) leaves the gate
      // pending and the retry redoes it.
      await settleGate(project.id, key, approval.approvalId, decision.option === 'approve' ? 'approved' : 'rejected', followUp)
      changed(project.id)
    })
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
        const { project, taskId, agentId } = steward.identity
        const gateKind = params.gateKind
        if (gateKind !== 'complete' && gateKind !== 'signoff') return { ok: false, error: 'gateKind must be "complete" or "signoff"', code: 'invalid_request' }
        const summary = typeof params.summary === 'string' ? params.summary.trim().slice(0, SUMMARY_MAX) : ''
        if (!summary) return { ok: false, error: 'summary is required', code: 'invalid_request' }
        return withGateLock(project.id, () => request({ projectId: project.id, taskId, agentId, gateKind, summary, subjectTaskId: params.subjectTaskId }))
      },
    })
  }

  async function request(input: { projectId: string; taskId: string; agentId: string; gateKind: GateKind; summary: string; subjectTaskId: unknown }): Promise<ExecToolResult> {
    const { projectId, taskId, agentId, gateKind, summary } = input
    /** Still the open check-in of an active project — re-checked after every await. */
    const stillOurs = () => {
      const current = repo.readProject(projectId)
      return current?.status === 'active' && current.steward?.openTaskId === taskId ? current : null
    }
    if (!stillOurs()) return { ok: false, error: 'This check-in is no longer open on an active project.', code: 'not_steward' }

    let subject = 'project'
    let deliverable: Task | null = null
    if (gateKind === 'signoff') {
      deliverable = typeof input.subjectTaskId === 'string' ? await ctx.tasks.get(input.subjectTaskId) : null
      if (!deliverable || deliverable.projectId !== projectId || isStewardTask(deliverable)) {
        return { ok: false, error: 'subjectTaskId must be one of this project\'s board tasks', code: 'invalid_subject' }
      }
      subject = deliverable.id
    }
    const key = gateKey(gateKind, subject)
    /** A request that returns an existing record: pending, or a deliverable already signed off and done. */
    const reuse = (prior: ProjectGateState | undefined) => prior?.state === 'pending'
      || (prior?.state === 'approved' && gateKind === 'signoff' && deliverable?.column === 'done')
    const known = repo.readProject(projectId)?.gates?.[key]
    if (reuse(known)) return { ok: true, approvalId: known!.approvalId, state: known!.state, message: 'Already asked. Finish this check-in now.' }

    // The board's Review column carries the "Needs approval" signal — moved
    // BEFORE the approval exists, so a fast decision can never be undone by
    // a late move back to review. Prior columns are kept to compensate.
    const moved: Array<[string, Task['column']]> = []
    try {
      for (const id of gateKind === 'signoff' ? [taskId, subject] : [taskId]) {
        const task = await ctx.tasks.get(id)
        if (task && task.column !== 'review') {
          await ctx.tasks.move(id, 'review')
          moved.push([id, task.column])
        }
      }
    } catch (err) {
      return { ok: false, error: `Could not move the task to review: ${err instanceof Error ? err.message : String(err)}`, code: 'board_unavailable' }
    }

    const outcome = await withProjectLock(() => {
      const current = stillOurs()
      if (!current) return { error: 'not_steward' as const }
      const prior = current.gates?.[key]
      if (reuse(prior)) return { approvalId: prior!.approvalId, state: prior!.state, created: false }
      // Rejected, cancelled, or approved in an earlier lifecycle (a
      // reopened project, a reworked deliverable): a new generation.
      const generation = (prior?.generation ?? 0) + 1
      const approvalId = gateApprovalId(projectId, gateKind, subject, generation)
      ctx.approvals.request({
        approvalId,
        gateKind,
        entityId: projectId,
        taskId: gateKind === 'complete' ? taskId : subject,
        title: gateKind === 'complete' ? `Complete “${current.title}”?` : `Sign off “${deliverable!.title}”?`,
        summary,
      })
      current.gates = { ...current.gates, [key]: { approvalId, generation, state: 'pending', stewardTaskId: taskId, stewardAgentId: agentId } }
      repo.writeProject(current)
      return { approvalId, state: 'pending' as const, created: true }
    })
    if ('error' in outcome) {
      // The project moved on while the board was being moved: put it back.
      for (const [id, column] of moved) await moveTask(id, column).catch(err => log.warn('could not undo a review move', { id, err }))
      return { ok: false, error: 'This check-in is no longer open on an active project.', code: 'not_steward' }
    }
    if (outcome.created) {
      ctx.activity.audit('steward.request_signoff', agentId, { projectId, taskId, gateKind, approvalId: outcome.approvalId })
      changed(projectId)
    }
    return { ok: true, approvalId: outcome.approvalId, state: outcome.state, message: 'The user decides on the board. Finish this check-in now.' }
  }

  return { registerGates, registerTool, cleanup, ownerState }
}

export type StewardGates = ReturnType<typeof createStewardGates>
