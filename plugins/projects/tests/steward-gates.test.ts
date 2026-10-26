/**
 * Sign-off gates + completion cleanup (D26, D28) through the activated
 * plugin and the test context's approvals (the host's resolve rules:
 * operator-only, gate runs before the decision lands, compare-and-set).
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import projectsPlugin from '../index'
import { createProjectRepository, type ProjectRepository } from '../lib/parser'
import { createStewardGates } from '../lib/steward/gates'
import { stewardEligibility } from '../lib/steward/scan'
import { activatePlugin, callRoute, callTool, findRoute, findTool, MarkdownStorageAdapter, type ActivatedPlugin } from '../test-helpers'
import type { Project } from '../types'

const root = join(tmpdir(), `projects-steward-gates-${Date.now()}`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const testGlobal = globalThis as typeof globalThis & { __bakinProjectIndex?: unknown; __bakinProjectLock?: unknown }
const OPERATOR = { 'X-Bakin-Operator': 'declared' }
const STEWARD_TASK = 'task-steward-1'
const COMPLETE_ID = 'projects:p1:complete:project:1'

let plugin: ActivatedPlugin
let repo: ProjectRepository
let n = 0

async function setup(): Promise<void> {
  testGlobal.__bakinProjectIndex = undefined
  testGlobal.__bakinProjectLock = undefined
  const dir = join(root, `case-${++n}`)
  repo = createProjectRepository(new MarkdownStorageAdapter(dir))
  const project: Project = {
    id: 'p1', title: 'Launch', titleSource: 'user', status: 'active',
    created: '2026-10-20T00:00:00.000Z', updated: '2026-10-25T00:00:00.000Z', owner: 'pixel',
    tasks: [{ id: 't001', title: 'Write copy', instanceId: 'i-1', checked: false, taskId: 'work-1' }],
    assets: [], planRevision: 1, body: 'Plan', progress: 0,
    steward: { openTaskId: STEWARD_TASK, phase: 'created', frozen: { title: 'Check in: Launch', assignee: 'pixel', description: 'brief' } },
  }
  repo.writeProject(project)
  plugin = await activatePlugin(projectsPlugin, dir)
  await plugin.ctx.tasks.create({ id: STEWARD_TASK, title: 'Check in: Launch', agent: 'pixel', projectId: 'p1', column: 'inProgress', source: { pluginId: 'projects', entityType: 'steward', entityId: 'p1' } })
  await plugin.ctx.tasks.create({ id: 'work-1', title: 'Write copy', agent: 'scribe', projectId: 'p1', column: 'inProgress', description: 'Draft the page copy.', source: { pluginId: 'projects', entityType: 'checklist', entityId: 'p1:i-1' } })
}

const read = () => repo.readProject('p1')!
const column = async (id: string) => (await plugin.ctx.tasks.get(id))?.column
const signoff = (extra: Record<string, unknown> = {}) => callTool(findTool(plugin.execTools, 'bakin_exec_projects_request_signoff')!, {
  projectId: 'p1', taskId: STEWARD_TASK, gateKind: 'complete', summary: 'All three steps are done and reviewed.', ...extra,
})
const notes = () => repo.readBrainstormMessages('p1').filter(r => r.kind === 'assistant').map(r => r.kind === 'assistant' ? r.content : '')

describe('complete gate', () => {
  beforeEach(setup)

  it('requests a deterministic approval anchored on the check-in task, which moves to review', async () => {
    const result = await signoff()
    expect(result).toEqual(expect.objectContaining({ ok: true, approvalId: COMPLETE_ID, state: 'pending' }))
    expect(plugin.ctx.approvals.get(COMPLETE_ID)).toEqual(expect.objectContaining({
      gateKind: 'complete', entityId: 'p1', taskId: STEWARD_TASK, status: 'pending', title: 'Complete “Launch”?', summary: 'All three steps are done and reviewed.',
    }))
    expect(await column(STEWARD_TASK)).toBe('review')
    expect(read().gates).toEqual({ 'complete:project': { approvalId: COMPLETE_ID, generation: 1, state: 'pending', stewardTaskId: STEWARD_TASK } })
    expect(stewardEligibility(read())).toBe('completion_pending')
    // Re-requesting while pending is a no-op returning the same id.
    expect(await signoff({ summary: 'Again' })).toEqual(expect.objectContaining({ approvalId: COMPLETE_ID }))
    expect(plugin.approvals.all()).toHaveLength(1)
  })

  it('approve completes the project without cancelling its own resolution; the rest is cleaned up', async () => {
    await signoff()
    await signoff({ gateKind: 'signoff', subjectTaskId: 'work-1', summary: 'Copy is ready' })
    repo.writeProject({ ...read(), waitingOn: { kind: 'input', questionId: 'q_0000000000000000', question: '?', since: '2026-10-26T00:00:00Z' } })
    const resolved = await plugin.approvals.resolve(COMPLETE_ID, 'approve')
    expect(resolved.status).toBe('approved')
    expect(read().status).toBe('completed')
    expect(await column(STEWARD_TASK)).toBe('done')
    expect(read().gates?.['complete:project']?.state).toBe('approved')
    expect(read().gates?.['signoff:work-1']?.state).toBe('cancelled')
    expect(plugin.ctx.approvals.get('projects:p1:signoff:work-1:1')?.status).toBe('cancelled')
    expect(read().steward?.openTaskId).toBeUndefined()
    expect(read().waitingOn).toBeUndefined()
  })

  it('reject keeps the project active, notes the reason and lets a re-request bump the generation', async () => {
    await signoff()
    await plugin.approvals.resolve(COMPLETE_ID, 'reject', 'The FAQ still needs a pass')
    expect(read().status).toBe('active')
    expect(read().gates?.['complete:project']).toEqual(expect.objectContaining({ state: 'rejected', generation: 1 }))
    expect(await column(STEWARD_TASK)).toBe('done')
    expect(notes()).toEqual([expect.stringContaining('“The FAQ still needs a pass”')])
    expect(stewardEligibility(read())).toBe('run_open')

    const again = await signoff()
    expect(again.approvalId).toBe('projects:p1:complete:project:2')
    expect(read().gates?.['complete:project']?.generation).toBe(2)
  })

  it('a manual Mark complete while the sign-off is pending cancels it — the late decision finds nothing to resolve', async () => {
    await signoff()
    const res = await callRoute(findRoute(plugin.routes, 'PUT', '/:projectId')!, plugin.ctx, {
      path: '/p1', searchParams: { projectId: 'p1' }, body: { status: 'completed' }, headers: OPERATOR,
    })
    expect(res.status).toBe(200)
    expect(plugin.ctx.approvals.get(COMPLETE_ID)?.status).toBe('cancelled')
    expect(read().gates?.['complete:project']?.state).toBe('cancelled')
    expect(await column(STEWARD_TASK)).toBe('archived')
    await expect(plugin.approvals.resolve(COMPLETE_ID, 'approve')).rejects.toThrow('No pending approval')
  })
})

describe('signoff gate', () => {
  beforeEach(setup)

  it('only accepts one of this project\'s work tasks as the subject', async () => {
    expect(await signoff({ gateKind: 'signoff', subjectTaskId: STEWARD_TASK })).toEqual(expect.objectContaining({ ok: false, code: 'invalid_subject' }))
    expect(await signoff({ gateKind: 'signoff', subjectTaskId: 'nope' })).toEqual(expect.objectContaining({ ok: false, code: 'invalid_subject' }))
    expect(await signoff({ gateKind: 'signoff' })).toEqual(expect.objectContaining({ ok: false, code: 'invalid_subject' }))
  })

  it('approve: the deliverable is done and the asking check-in closes', async () => {
    const { approvalId } = await signoff({ gateKind: 'signoff', subjectTaskId: 'work-1', summary: 'Copy is ready' })
    expect(plugin.ctx.approvals.get(approvalId as string)?.taskId).toBe('work-1')
    expect(await column('work-1')).toBe('review')
    expect(await column(STEWARD_TASK)).toBe('review')
    await plugin.approvals.resolve(approvalId as string, 'approve')
    expect(await column('work-1')).toBe('done')
    expect(await column(STEWARD_TASK)).toBe('done')
    expect(read().gates?.['signoff:work-1']?.state).toBe('approved')
  })

  it('reject: the reason lands on the task and in the conversation, and the task goes back to todo', async () => {
    const { approvalId } = await signoff({ gateKind: 'signoff', subjectTaskId: 'work-1', summary: 'Copy is ready' })
    await plugin.approvals.resolve(approvalId as string, 'reject', 'Tone is too formal')
    const task = (await plugin.ctx.tasks.get('work-1'))!
    expect(task.column).toBe('todo')
    expect(task.description).toBe('Draft the page copy.\n\nSign-off declined: Tone is too formal')
    expect(task.log?.at(-1)?.message).toBe('Sign-off declined: Tone is too formal')
    expect(notes()).toEqual(['You sent “Write copy” back: “Tone is too formal”'])
    expect(read().gates?.['signoff:work-1']?.state).toBe('rejected')
  })
})

describe('gate owner state', () => {
  beforeEach(setup)

  it('is live while the project is active and the generation matches; stale otherwise', async () => {
    await signoff()
    const gate = plugin.ctx.approvals.get(COMPLETE_ID)!
    const turns = plugin.ctx.conversations.createTurnService({
      name: 'x', events: { chunk: 'c', done: 'd', error: 'e' }, payload: () => ({}), resolveThread: () => null, appendRow: () => {}, threadId: () => '',
    })
    const gates = createStewardGates({ ctx: plugin.ctx, repo, turns, projectService: { updateProject: async () => {} } })
    expect(await gates.ownerState(gate)).toBe('live')
    repo.writeProject({ ...read(), gates: { 'complete:project': { approvalId: 'projects:p1:complete:project:2', generation: 2, state: 'pending' } } })
    expect(await gates.ownerState(gate)).toBe('orphaned')
    repo.writeProject({ ...read(), status: 'completed', gates: { 'complete:project': { approvalId: COMPLETE_ID, generation: 1, state: 'pending' } } })
    expect(await gates.ownerState(gate)).toBe('orphaned')
    repo.deleteProjectFile('p1')
    expect(await gates.ownerState(gate)).toBe('orphaned')
  })

  it('a pending completion whose check-in task already finished stays valid', async () => {
    await signoff()
    await plugin.ctx.tasks.move(STEWARD_TASK, 'done')
    await plugin.approvals.resolve(COMPLETE_ID, 'approve')
    expect(read().status).toBe('completed')
  })
})
