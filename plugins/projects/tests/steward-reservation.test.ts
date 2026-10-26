import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PluginContext, Task } from '@makinbakin/sdk/types'
import { createTestContext } from '../test-helpers'
import { createProjectRepository, type ProjectRepository } from '../lib/parser'
import { createStewardLoop, readStewardSettings, STEWARD_DEFAULTS, STEWARD_TAG, type StewardLoop, type StewardSettings } from '../lib/steward/reservation'
import type { Project } from '../types'

const root = join(tmpdir(), `projects-steward-reservation-${Date.now()}`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

let ctx: PluginContext
let repo: ProjectRepository
let loop: StewardLoop
let clock: Date
let config: StewardSettings
let audits: Array<[string, Record<string, unknown>]>
let n = 0

const HOUR = 3_600_000

function writeProject(extra: Partial<Project> = {}): Project {
  const project: Project = {
    id: 'p1', title: 'Launch', titleSource: 'user', status: 'active',
    created: '2026-10-20T00:00:00.000Z', updated: new Date(clock.getTime() - HOUR).toISOString(),
    owner: 'pixel', tasks: [{ id: 't001', title: 'Write copy', instanceId: 'i-1', checked: false, taskId: 'work-1' }],
    assets: [], planRevision: 1, body: 'Ship the launch page.', progress: 0, ...extra,
  }
  repo.writeProject(project)
  return project
}

async function addWork(column: Task['column'] = 'blocked'): Promise<void> {
  await ctx.tasks.create({ id: 'work-1', title: 'Write copy', projectId: 'p1', column, agent: 'scribe' })
}

const stewardTasks = async () => (await ctx.tasks.list({ projectId: 'p1' })).filter(t => t.source?.entityType === 'steward')
const stewardState = () => repo.readProject('p1')?.steward
const flushTimers = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  const activated = createTestContext('projects', join(root, `case-${++n}`))
  ctx = activated.ctx
  audits = []
  ctx.activity.audit = ((action: string, _actor: string, data: Record<string, unknown>) => { audits.push([action, data]) }) as PluginContext['activity']['audit']
  repo = createProjectRepository(ctx.storage)
  clock = new Date('2026-10-26T12:00:00')
  config = { ...STEWARD_DEFAULTS }
  loop = createStewardLoop({ ctx, repo, now: () => clock, settings: () => config, debounceMs: 1 })
})

describe('steward reservation', () => {
  it('creates one steward task for a blocked step, reserved with frozen inputs and tagged for routing', async () => {
    writeProject()
    await addWork('blocked')
    const outcome = await loop.scan('p1')
    expect(outcome).toEqual({ created: expect.stringMatching(/^task-/) })
    const [task, ...rest] = await stewardTasks()
    expect(rest).toEqual([])
    expect(task).toEqual(expect.objectContaining({
      id: (outcome as { created: string }).created,
      title: 'Check in: Launch',
      agent: 'pixel',
      projectId: 'p1',
      tags: [STEWARD_TAG],
      source: { pluginId: 'projects', entityType: 'steward', entityId: 'p1' },
    }))
    expect(task!.description).toContain(`task id ${task!.id}`)
    expect(task!.description).toContain('Blocked board tasks: "Write copy"')
    expect(stewardState()).toEqual(expect.objectContaining({ openTaskId: task!.id, phase: 'created', runs: { date: '2026-10-26', count: 1 } }))
    // Bookkeeping is not project activity.
    expect(repo.readProject('p1')!.updated).toBe(new Date(clock.getTime() - HOUR).toISOString())
  })

  it('simultaneous timer, event and manual (forced) triggers yield one task', async () => {
    writeProject()
    await addWork('blocked')
    const outcomes = await Promise.all([
      loop.scan('p1'),
      loop.scanAll().then(() => null),
      loop.scan('p1', { force: true }),
      loop.scan('p1'),
    ])
    loop.onTaskStatusChanged({ taskId: 'work-1', from: 'todo', to: 'blocked', task: (await ctx.tasks.get('work-1'))! })
    await flushTimers()
    await loop.scan('p1')
    expect(await stewardTasks()).toHaveLength(1)
    expect(outcomes.filter(o => o && 'created' in o)).toHaveLength(1)
    expect(stewardState()?.runs?.count).toBe(1)
  })

  it('a crash between reserve and create recovers the identical task exactly once', async () => {
    writeProject()
    await addWork('blocked')
    const realCreate = ctx.tasks.create
    ctx.tasks.create = async () => { throw new Error('process died') }
    expect(await loop.scan('p1')).toEqual({ skipped: 'create_failed' })
    const reserved = stewardState()!
    expect(reserved.phase).toBe('reserved')
    expect(await stewardTasks()).toEqual([])

    ctx.tasks.create = realCreate
    // The reconcile at the head of the next scan creates from the frozen inputs.
    expect(await loop.scan('p1')).toEqual({ skipped: 'run_open' })
    await loop.scan('p1')
    const tasks = await stewardTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual(expect.objectContaining({ id: reserved.openTaskId, description: reserved.frozen!.description }))
    expect(stewardState()).toEqual(expect.objectContaining({ phase: 'created', runs: { date: '2026-10-26', count: 1 } }))
  })

  it('a create that throws after landing is treated as created, never duplicated', async () => {
    writeProject()
    await addWork('blocked')
    const realCreate = ctx.tasks.create
    ctx.tasks.create = async (input) => { await realCreate(input); throw new Error('lost response') }
    expect(await loop.scan('p1')).toEqual({ created: expect.any(String) })
    ctx.tasks.create = realCreate
    await loop.scan('p1')
    expect(await stewardTasks()).toHaveLength(1)
    expect(stewardState()?.phase).toBe('created')
  })

  it('steward completion never re-triggers: the finished run records what it handled', async () => {
    writeProject()
    await addWork('blocked')
    const { created } = await loop.scan('p1') as { created: string }
    const done = await ctx.tasks.move(created, 'done')
    // Its own transition schedules nothing.
    loop.onTaskStatusChanged({ taskId: created, from: 'todo', to: 'done', task: done })
    await flushTimers()
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 15 * 60_000)
      expect(await loop.scan('p1')).toEqual({ skipped: 'unchanged' })
    }
    expect(await stewardTasks()).toHaveLength(1)
    expect(stewardState()).toEqual(expect.objectContaining({ lastStewardAt: expect.any(String), lastFingerprint: expect.any(String) }))
    expect(stewardState()?.openTaskId).toBeUndefined()
  })

  it('a work-task transition schedules a debounced scan; other columns do not', async () => {
    writeProject()
    await addWork('inProgress')
    const moved = await ctx.tasks.move('work-1', 'inProgress')
    loop.onTaskStatusChanged({ taskId: 'work-1', from: 'todo', to: 'inProgress', task: moved })
    await flushTimers()
    expect(await stewardTasks()).toEqual([])
    const blocked = await ctx.tasks.move('work-1', 'blocked')
    loop.onTaskStatusChanged({ taskId: 'work-1', from: 'inProgress', to: 'blocked', task: blocked })
    loop.onTaskStatusChanged({ taskId: 'work-1', from: 'inProgress', to: 'blocked', task: blocked })
    await flushTimers(20)
    expect(await stewardTasks()).toHaveLength(1)
  })

  it('the daily cap holds and is audited once per day', async () => {
    config = { ...config, maxRunsPerDay: 2 }
    writeProject()
    await addWork('blocked')
    for (const column of ['review', 'blocked'] as const) {
      const { created } = await loop.scan('p1', { force: true }) as { created: string }
      await ctx.tasks.move(created, 'done')
      await ctx.tasks.move('work-1', column)
    }
    expect(await loop.scan('p1', { force: true })).toEqual({ skipped: 'daily_cap' })
    expect(await loop.scan('p1', { force: true })).toEqual({ skipped: 'daily_cap' })
    expect(audits.filter(([action]) => action === 'steward.cap_reached')).toHaveLength(1)
    expect(await stewardTasks()).toHaveLength(2)
    // A new local day resets the count.
    clock = new Date('2026-10-27T08:00:00')
    expect(await loop.scan('p1', { force: true })).toEqual({ created: expect.any(String) })
  })

  it('a deleted steward task is finalized as abandoned; a foreign task at the reserved id is cleared', async () => {
    writeProject()
    await addWork('blocked')
    const { created } = await loop.scan('p1') as { created: string }
    await ctx.tasks.remove(created)
    await loop.reconcile('p1')
    expect(stewardState()?.openTaskId).toBeUndefined()
    expect(audits.some(([action]) => action === 'steward.abandoned')).toBe(true)

    const foreignId = 'task-foreign'
    await ctx.tasks.create({ id: foreignId, title: 'Someone else', projectId: 'p1' })
    repo.writeProject({ ...repo.readProject('p1')!, steward: { openTaskId: foreignId, phase: 'created' } })
    await loop.reconcile('p1')
    expect(stewardState()?.openTaskId).toBeUndefined()
    expect(audits.some(([action, data]) => action === 'steward.foreign' && data.taskId === foreignId)).toBe(true)
  })

  it('leaves non-active, paused and disabled projects alone', async () => {
    writeProject({ status: 'draft' })
    await addWork('blocked')
    expect(await loop.scan('p1', { force: true })).toEqual({ skipped: 'not_active' })
    writeProject({ stewardPaused: true })
    expect(await loop.scan('p1', { force: true })).toEqual({ skipped: 'paused' })
    writeProject()
    config = { ...config, enabled: false }
    expect(await loop.scan('p1', { force: true })).toEqual({ skipped: 'disabled' })
    expect(await stewardTasks()).toEqual([])
  })

  it('round-trips steward state through the project file', () => {
    writeProject({
      stewardPaused: true,
      steward: { openTaskId: 'task-x', phase: 'reserved', frozen: { title: 'Check in', assignee: 'pixel', description: 'd' }, runs: { date: '2026-10-26', count: 2 } },
      waitingOn: { kind: 'input', questionId: 'q1', question: 'Which?', since: '2026-10-26T00:00:00Z' },
      gates: { 'complete:project': { approvalId: 'projects:p1:complete:project:1', generation: 1, state: 'pending' } },
    })
    const read = repo.readProject('p1')!
    expect(read.stewardPaused).toBe(true)
    expect(read.steward?.frozen?.assignee).toBe('pixel')
    expect(read.waitingOn?.questionId).toBe('q1')
    expect(read.gates?.['complete:project']?.state).toBe('pending')
  })
})

describe('steward settings (D29)', () => {
  it('the schema declares every knob with the loop\'s defaults; bad values fall back', async () => {
    const { default: plugin } = await import('../index')
    const fields = Object.fromEntries((plugin.settingsSchema?.fields ?? []).map(field => [field.key, field.default]))
    expect(fields).toEqual({
      stewardEnabled: STEWARD_DEFAULTS.enabled,
      stewardScanMinutes: STEWARD_DEFAULTS.scanMinutes,
      stewardStuckAfterHours: STEWARD_DEFAULTS.stuckAfterHours,
      stewardMaxRunsPerDay: STEWARD_DEFAULTS.maxRunsPerDay,
    })
    ctx.getSettings = (() => ({ stewardEnabled: false, stewardScanMinutes: 0, stewardStuckAfterHours: -1, stewardMaxRunsPerDay: 'many' })) as PluginContext['getSettings']
    expect(readStewardSettings(ctx)).toEqual({ ...STEWARD_DEFAULTS, enabled: false })
  })
})
