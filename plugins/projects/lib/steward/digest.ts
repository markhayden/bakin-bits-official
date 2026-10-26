/**
 * The steward's digest (D20, D20a): a deterministic read of one project and
 * its board tasks — no LLM. Signals say what might need the lead's judgement;
 * the fingerprint says whether that situation is NEW. Pure: callers pass the
 * clock.
 */
import { createHash } from 'node:crypto'
import type { Task } from '@makinbakin/sdk/types'
import type { Project, ProjectStewardState } from '../../types'

export const STEWARD_ENTITY_TYPE = 'steward'

export const STEWARD_SIGNAL_KINDS = ['blocked', 'idle-review', 'unpromoted', 'work-done', 'all-done', 'stalled'] as const
export type StewardSignalKind = (typeof STEWARD_SIGNAL_KINDS)[number]

export interface StewardSignal {
  kind: StewardSignalKind
  /** Board tasks (blocked / idle-review / work-done) or step ids (unpromoted). */
  refs: string[]
}

export interface WorkTaskFact {
  id: string
  title: string
  column: string
  agent?: string
  updatedAt?: string
  blockedReason?: string
}

export interface StewardDigest {
  projectId: string
  signals: StewardSignal[]
  /** Board work for the project, steward tasks excluded. */
  workTasks: WorkTaskFact[]
  fingerprint: string
}

/** A task the steward loop created for this project (never a work signal). */
export function isStewardTask(task: Pick<Task, 'source'>, projectId?: string): boolean {
  const source = task.source
  return source?.pluginId === 'projects' && source.entityType === STEWARD_ENTITY_TYPE
    && (projectId === undefined || source.entityId === projectId)
}

const DONE_COLUMNS = new Set(['done', 'archived'])
/** Work that is moving or waiting on someone — "something in flight". */
const IN_FLIGHT_COLUMNS = new Set(['todo', 'inProgress', 'review', 'blocked'])

function ms(iso: string | undefined): number {
  const value = iso ? Date.parse(iso) : NaN
  return Number.isFinite(value) ? value : NaN
}

/**
 * The canonical fingerprint (D20a): signal kinds, work-task ids + columns,
 * steps by instance with their derived checked/linked state, and the plan
 * revision. Never timestamps, steward bookkeeping or steward tasks — a
 * situation that has not changed hashes the same at every scan.
 */
export function stewardFingerprint(project: Project, signals: StewardSignal[], workTasks: WorkTaskFact[], board: ReadonlyMap<string, { column: string }>): string {
  const steps = project.tasks.map(step => {
    const linked = Boolean(step.taskId)
    const checked = linked ? DONE_COLUMNS.has(board.get(step.taskId!)?.column ?? '') : step.checked
    return `${step.instanceId ?? step.id}:${checked ? 1 : 0}:${linked ? 1 : 0}`
  }).sort()
  const canonical = JSON.stringify({
    signals: signals.map(s => s.kind).sort(),
    work: workTasks.map(t => `${t.id}:${t.column}`).sort(),
    steps,
    planRevision: project.planRevision,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export interface DigestOptions {
  now: Date
  stuckAfterMs: number
  steward?: ProjectStewardState
}

export function buildStewardDigest(project: Project, tasks: Task[], opts: DigestOptions): StewardDigest {
  const now = opts.now.getTime()
  const work = tasks.filter(task => task.projectId === project.id && !isStewardTask(task))
  const board = new Map(work.map(task => [task.id, task]))
  const workTasks: WorkTaskFact[] = work.map(task => ({
    id: task.id,
    title: task.title,
    column: task.column,
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
  }))

  const signals: StewardSignal[] = []
  const push = (kind: StewardSignalKind, refs: string[]) => { if (refs.length) signals.push({ kind, refs: [...refs].sort() }) }

  push('blocked', workTasks.filter(t => t.column === 'blocked').map(t => t.id))
  push('idle-review', workTasks
    .filter(t => t.column === 'review' && now - ms(t.updatedAt) > opts.stuckAfterMs)
    .map(t => t.id))

  const derivedChecked = (step: Project['tasks'][number]) => step.taskId
    ? DONE_COLUMNS.has(board.get(step.taskId)?.column ?? '')
    : step.checked
  const unpromoted = project.tasks.filter(step => !step.taskId && !step.checked)
  const inFlight = workTasks.some(t => IN_FLIGHT_COLUMNS.has(t.column))
  if (!inFlight) push('unpromoted', unpromoted.map(step => step.id))

  // Follow-on judgement: work that REACHED done since the steward last
  // looked — a column change against what the last run left behind (an edit
  // to finished work moves updatedAt but finishes nothing). Before any run
  // has finished there is no baseline, so the timestamp stands in.
  const handled = opts.steward?.handledColumns
  const since = ms(opts.steward?.lastStewardAt)
  push('work-done', workTasks
    .filter(t => t.column === 'done' && (handled
      ? handled[t.id] !== 'done'
      : !Number.isFinite(since) || ms(t.updatedAt) > since))
    .map(t => t.id))

  const unfinished = project.tasks.filter(step => !derivedChecked(step))
  if (project.tasks.length > 0 && unfinished.length === 0) push('all-done', project.tasks.map(step => step.id))

  // Stalled: nothing on the board has moved for the window while steps remain.
  if (unfinished.length > 0) {
    const moments = [...workTasks.map(t => t.updatedAt), opts.steward?.lastStewardAt, project.updated]
      .map(ms)
      .filter(Number.isFinite)
    if (moments.length && now - Math.max(...moments) > opts.stuckAfterMs) push('stalled', unfinished.map(step => step.id))
  }

  return {
    projectId: project.id,
    signals,
    workTasks,
    fingerprint: stewardFingerprint(project, signals, workTasks, board),
  }
}
