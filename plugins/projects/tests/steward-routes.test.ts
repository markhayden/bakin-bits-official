/**
 * The steward's user-facing routes (D27, D29): Start hands off with an
 * immediate check-in, Pause/Resume is the operator's, and the list carries
 * the steward signals.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import projectsPlugin from '../index'
import { createProjectRepository, type ProjectRepository } from '../lib/parser'
import { localDay } from '../lib/steward/reservation'
import { activatePlugin, callRoute, findRoute, MarkdownStorageAdapter, type ActivatedPlugin } from '../test-helpers'
import type { Project, ProjectSummary } from '../types'

const root = join(tmpdir(), `projects-steward-routes-${Date.now()}`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const testGlobal = globalThis as typeof globalThis & { __bakinProjectIndex?: unknown; __bakinProjectLock?: unknown; __bakinProjectAdmissionFence?: unknown; __bakinProjectGateQueues?: unknown }
const OPERATOR = { 'X-Bakin-Operator': 'declared' }

let plugin: ActivatedPlugin
let repo: ProjectRepository
let n = 0

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id, title: `Project ${id}`, titleSource: 'user', status: 'active',
    created: '2026-10-20T00:00:00.000Z', updated: new Date().toISOString(), owner: 'pixel',
    tasks: [], assets: [], planRevision: 1, body: 'Plan', progress: 0, ...extra,
  }
}

beforeEach(async () => {
  testGlobal.__bakinProjectIndex = undefined
  testGlobal.__bakinProjectLock = undefined
  testGlobal.__bakinProjectAdmissionFence = undefined
  testGlobal.__bakinProjectGateQueues = undefined
  const dir = join(root, `case-${++n}`)
  repo = createProjectRepository(new MarkdownStorageAdapter(dir))
  plugin = await activatePlugin(projectsPlugin, dir)
})

async function waitUntil(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const put = (id: string, body: Record<string, unknown>, headers: Record<string, string> = OPERATOR) =>
  callRoute(findRoute(plugin.routes, 'PUT', '/:projectId')!, plugin.ctx, { path: `/${id}`, searchParams: { projectId: id }, body, headers })
const pause = (id: string, paused: unknown, headers: Record<string, string> = OPERATOR) =>
  callRoute(findRoute(plugin.routes, 'POST', '/:projectId/steward/pause')!, plugin.ctx, { path: `/${id}/steward/pause`, searchParams: { projectId: id }, body: { paused }, headers })
const stewardTasks = async (id: string) => (await plugin.ctx.tasks.list({ projectId: id })).filter(t => t.source?.entityType === 'steward')

describe('Start hand-off', () => {
  it('reserves the lead\'s first check-in at once — no steps yet means it breaks the plan down', async () => {
    repo.writeProject(project('p1', { status: 'draft' }))
    expect((await put('p1', { status: 'active', expected: { status: 'draft' } })).status).toBe(200)
    await waitUntil(async () => (await stewardTasks('p1')).length === 1, 'hand-off check-in')
    const [task] = await stewardTasks('p1')
    expect(task).toEqual(expect.objectContaining({ agent: 'pixel', title: 'Check in: Project p1' }))
    expect(task!.description).toContain('no steps yet: break the agreed plan into steps first')
  })

  it('a reopen is not a hand-off', async () => {
    repo.writeProject(project('p1', { status: 'completed' }))
    await put('p1', { status: 'active', expected: { status: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await stewardTasks('p1')).toEqual([])
  })
})

describe('Pause / Resume', () => {
  it('is the operator\'s: an agent caller is refused; the flag round-trips and status stays active', async () => {
    repo.writeProject(project('p1'))
    expect((await pause('p1', true, { 'X-Bakin-Agent-Context': 'pixel' })).status).toBe(403)
    expect(repo.readProject('p1')!.stewardPaused).toBeUndefined()
    expect((await pause('p1', 'yes')).status).toBe(400)
    expect((await pause('p1', true)).status).toBe(200)
    expect(repo.readProject('p1')).toEqual(expect.objectContaining({ stewardPaused: true, status: 'active' }))
    expect((await pause('p1', false)).status).toBe(200)
    expect(repo.readProject('p1')!.stewardPaused).toBeUndefined()
    expect((await pause('missing', true)).status).toBe(404)
  })
})

describe('list signals', () => {
  it('reports needs approval, stuck, today\'s cap and paused per project', async () => {
    const today = localDay(new Date())
    repo.writeProject(project('approval', { gates: { 'complete:project': { approvalId: 'projects:approval:complete:project:1', generation: 1, state: 'pending' } } }))
    repo.writeProject(project('stuck', { tasks: [{ id: 't001', title: 'Copy', instanceId: 'i-1', checked: false, taskId: 'work-1' }] }))
    repo.writeProject(project('capped', { steward: { runs: { date: today, count: 6 } } }))
    repo.writeProject(project('paused', { stewardPaused: true }))
    repo.writeProject(project('quiet'))
    await plugin.ctx.tasks.create({ id: 'work-1', title: 'Copy', projectId: 'stuck', column: 'blocked' })

    const res = await callRoute(findRoute(plugin.routes, 'GET', '/')!, plugin.ctx, { path: '/' })
    const byId = Object.fromEntries((res.body.projects as ProjectSummary[]).map(p => [p.id, p]))
    expect(byId.approval).toEqual(expect.objectContaining({ needsApproval: true, stuck: false }))
    expect(byId.stuck).toEqual(expect.objectContaining({ needsApproval: false, stuck: true }))
    expect(byId.capped).toEqual(expect.objectContaining({ checkinsPausedToday: true }))
    expect(byId.paused).toEqual(expect.objectContaining({ stewardPaused: true }))
    expect(byId.quiet).toEqual(expect.objectContaining({ needsApproval: false, stuck: false, checkinsPausedToday: false }))
    expect(byId.quiet!.stewardPaused).toBeUndefined()
  })
})
