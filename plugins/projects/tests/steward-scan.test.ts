import { describe, expect, it } from 'bun:test'
import type { Task } from '@makinbakin/sdk/types'
import { buildStewardDigest, isStewardTask, type StewardSignalKind } from '../lib/steward/digest'
import { decideStewardRun, stewardEligibility } from '../lib/steward/scan'
import type { Project, ProjectTask } from '../types'

const HOUR = 3_600_000
const STUCK = 24 * HOUR
const NOW = new Date('2026-10-26T12:00:00Z')
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString()

function step(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { id, title: `Step ${id}`, instanceId: `inst-${id}`, checked: false, ...extra }
}

function project(extra: Partial<Project> = {}): Project {
  return {
    id: 'p1', title: 'Launch', titleSource: 'user', status: 'active',
    created: ago(100), updated: ago(1), owner: 'main', tasks: [], assets: [],
    planRevision: 1, body: '', progress: 0, ...extra,
  }
}

function task(id: string, column: Task['column'], extra: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, column, checked: false, projectId: 'p1', updatedAt: ago(1), ...extra }
}

const steward = (id: string, column: Task['column'] = 'todo') =>
  task(id, column, { source: { pluginId: 'projects', entityType: 'steward', entityId: 'p1' }, updatedAt: ago(0) })

const kinds = (p: Project, tasks: Task[], lastStewardAt?: string) =>
  buildStewardDigest(p, tasks, { now: NOW, stuckAfterMs: STUCK, steward: lastStewardAt ? { lastStewardAt } : undefined })
    .signals.map(s => s.kind)

describe('steward digest signals', () => {
  const cases: Array<{ name: string; project: Project; tasks: Task[]; lastStewardAt?: string; expected: StewardSignalKind[] }> = [
    {
      name: 'progressing work raises nothing',
      project: project({ tasks: [step('t001', { taskId: 'a' })] }),
      tasks: [task('a', 'inProgress')],
      expected: [],
    },
    {
      name: 'a blocked work task',
      project: project({ tasks: [step('t001', { taskId: 'a' })] }),
      tasks: [task('a', 'blocked', { blockedReason: 'needs key' })],
      expected: ['blocked'],
    },
    {
      name: 'a review idle past the window (a fresh review is fine)',
      project: project({ tasks: [step('t001', { taskId: 'a' }), step('t002', { taskId: 'b' })] }),
      tasks: [task('a', 'review', { updatedAt: ago(30) }), task('b', 'review', { updatedAt: ago(2) })],
      expected: ['idle-review'],
    },
    {
      name: 'unpromoted steps with nothing in flight',
      project: project({ tasks: [step('t001'), step('t002', { taskId: 'a' })] }),
      tasks: [task('a', 'done', { updatedAt: ago(30) })],
      lastStewardAt: ago(20),
      expected: ['unpromoted'],
    },
    {
      name: 'unpromoted steps wait while work is in flight',
      project: project({ tasks: [step('t001'), step('t002', { taskId: 'a' })] }),
      tasks: [task('a', 'todo')],
      expected: [],
    },
    {
      name: 'work finished since the last steward run',
      project: project({ tasks: [step('t001', { taskId: 'a' }), step('t002', { taskId: 'b' })] }),
      tasks: [task('a', 'done', { updatedAt: ago(1) }), task('b', 'inProgress')],
      lastStewardAt: ago(3),
      expected: ['work-done'],
    },
    {
      name: 'every step done (linked steps derive from the board)',
      project: project({ tasks: [step('t001', { taskId: 'a', checked: false }), step('t002', { checked: true })] }),
      tasks: [task('a', 'done', { updatedAt: ago(5) })],
      lastStewardAt: ago(3),
      expected: ['all-done'],
    },
    {
      name: 'stalled: nothing moved for the window with steps left',
      project: project({ updated: ago(48), tasks: [step('t001', { taskId: 'a' })] }),
      tasks: [task('a', 'todo', { updatedAt: ago(40) })],
      lastStewardAt: ago(30),
      expected: ['stalled'],
    },
    {
      name: 'steward tasks never count as work',
      project: project({ tasks: [step('t001', { taskId: 'a' })] }),
      tasks: [task('a', 'inProgress'), steward('s1', 'blocked'), steward('s2', 'done')],
      expected: [],
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(kinds(c.project, c.tasks, c.lastStewardAt)).toEqual(c.expected)
    })
  }

  it('recognises only this project\'s steward tasks', () => {
    expect(isStewardTask(steward('s1'), 'p1')).toBe(true)
    expect(isStewardTask(steward('s1'), 'p2')).toBe(false)
    expect(isStewardTask(task('a', 'todo', { source: { pluginId: 'projects', entityType: 'checklist', entityId: 'p1:x' } }))).toBe(false)
  })
})

describe('steward fingerprint', () => {
  const base = project({ tasks: [step('t001', { taskId: 'a' }), step('t002')] })
  const fp = (p: Project, tasks: Task[]) => buildStewardDigest(p, tasks, { now: NOW, stuckAfterMs: STUCK }).fingerprint

  it('ignores timestamps, steward tasks and step order', () => {
    const one = fp(base, [task('a', 'blocked', { updatedAt: ago(2) })])
    expect(fp(base, [task('a', 'blocked', { updatedAt: ago(1) }), steward('s1')])).toBe(one)
    expect(fp({ ...base, tasks: [...base.tasks].reverse(), updated: ago(0) }, [task('a', 'blocked')])).toBe(one)
  })

  it('changes with a column, a step\'s derived state, a new step or a plan revision', () => {
    const one = fp(base, [task('a', 'blocked')])
    expect(fp(base, [task('a', 'review')])).not.toBe(one)
    expect(fp({ ...base, tasks: [...base.tasks, step('t003')] }, [task('a', 'blocked')])).not.toBe(one)
    expect(fp({ ...base, planRevision: 2 }, [task('a', 'blocked')])).not.toBe(one)
    expect(fp({ ...base, tasks: [base.tasks[0]!, step('t002', { checked: true })] }, [task('a', 'blocked')])).not.toBe(one)
  })
})

describe('steward run decision', () => {
  const blocked = project({ tasks: [step('t001', { taskId: 'a' })] })
  const board = [task('a', 'blocked')]
  const digestAt = (now: Date, p: Project) => buildStewardDigest(p, board, { now, stuckAfterMs: STUCK, steward: p.steward })

  it('an unchanged digest across N intervals creates nothing until the re-raise window', () => {
    const first = digestAt(NOW, blocked)
    expect(decideStewardRun(blocked, first, { now: NOW, stuckAfterMs: STUCK })).toEqual({ run: true, reason: 'changed' })
    // The run finished and recorded what it handled.
    const handled = { ...blocked, steward: { lastFingerprint: first.fingerprint, lastStewardAt: NOW.toISOString() } }
    for (let interval = 1; interval <= 20; interval++) {
      const now = new Date(NOW.getTime() + interval * 15 * 60_000)
      expect(decideStewardRun(handled, digestAt(now, handled), { now, stuckAfterMs: STUCK })).toEqual({ run: false, reason: 'unchanged' })
    }
    const later = new Date(NOW.getTime() + STUCK)
    expect(decideStewardRun(handled, digestAt(later, handled), { now: later, stuckAfterMs: STUCK })).toEqual({ run: true, reason: 're-raise' })
  })

  it('a quiet project creates nothing; Start forces one run even with no signals', () => {
    const quiet = project()
    const digest = buildStewardDigest(quiet, [], { now: NOW, stuckAfterMs: STUCK })
    expect(decideStewardRun(quiet, digest, { now: NOW, stuckAfterMs: STUCK })).toEqual({ run: false, reason: 'no_signals' })
    expect(decideStewardRun(quiet, digest, { now: NOW, stuckAfterMs: STUCK, force: true })).toEqual({ run: true, reason: 'forced' })
  })

  it('skips projects the loop must leave alone — even when forced', () => {
    const cases: Array<[Partial<Project>, string]> = [
      [{ status: 'draft' }, 'not_active'],
      [{ stewardPaused: true }, 'paused'],
      [{ waitingOn: { kind: 'input', questionId: 'q', question: '?', since: ago(1) } }, 'waiting_on_user'],
      [{ replyPending: { questionId: 'q' } }, 'waiting_on_user'],
      [{ gates: { 'complete:project': { approvalId: 'projects:p1:complete:project:1', generation: 1, state: 'pending' } } }, 'completion_pending'],
      [{ steward: { openTaskId: 's1', phase: 'created' } }, 'run_open'],
    ]
    for (const [patch, reason] of cases) {
      const p = { ...blocked, ...patch }
      expect(stewardEligibility(p)).toBe(reason as never)
      expect(decideStewardRun(p, digestAt(NOW, p), { now: NOW, stuckAfterMs: STUCK, force: true })).toEqual({ run: false, reason } as never)
    }
    const rejected = { ...blocked, gates: { 'complete:project': { approvalId: 'x', generation: 1, state: 'rejected' as const } } }
    expect(stewardEligibility(rejected)).toBeNull()
  })
})
