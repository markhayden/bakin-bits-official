import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectRepository, parseProject, serializeProject } from '../lib/parser'
import { createProjectService } from '../lib/project-service'
import { createTestContext } from '../test-helpers'

let root: string
let setup: ReturnType<typeof createTestContext>
let repo: ReturnType<typeof createProjectRepository>
let service: ReturnType<typeof createProjectService>
let id: string
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'checklist-operations-'))
  setup = createTestContext('projects', root)
  repo = createProjectRepository(setup.ctx.storage)
  service = createProjectService(setup.ctx, repo)
  id = (await service.createProject({ title: 'Project' })).id
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('replays a lost add response across service restart and concurrent requests', async () => {
  const first = await service.addChecklistItem(id, 'Task', 'request-one')
  service = createProjectService(setup.ctx, createProjectRepository(setup.ctx.storage))
  const retries = await Promise.all(Array.from({ length: 8 }, () => service.addChecklistItem(id, ' Task ', 'request-one')))
  expect(retries.every(result => result.taskItemId === first.taskItemId)).toBe(true)
  expect(repo.readProject(id)?.tasks).toHaveLength(1)
  await expect(service.addChecklistItem(id, 'Different', 'request-one')).rejects.toMatchObject({ status: 409 })
})

it('does not resurrect a deleted add result or confuse a reused display ID', async () => {
  const first = await service.addChecklistItem(id, 'Original', 'request-one')
  await service.removeChecklistItem(id, first.taskItemId)
  const replacement = await service.addChecklistItem(id, 'Replacement', 'request-two')
  expect(replacement.taskItemId).toBe(first.taskItemId)
  expect(await service.addChecklistItem(id, 'Original', 'request-one')).toMatchObject({ taskItemId: first.taskItemId, deleted: true })
  expect(repo.readProject(id)?.tasks.map(item => item.title)).toEqual(['Replacement'])
})

it('commits the receipt with its item and can retry a failed replacement', async () => {
  const write = repo.writeProject
  repo.writeProject = () => { throw new Error('write failed') }
  await expect(service.addChecklistItem(id, 'Task', 'request-one')).rejects.toThrow('write failed')
  expect(repo.readProject(id)?.tasks).toHaveLength(0)
  repo.writeProject = write
  await service.addChecklistItem(id, 'Task', 'request-one')
  expect(repo.readProject(id)?.tasks).toHaveLength(1)
  expect(repo.readProject(id)?.operations).toHaveLength(1)
})

it('retains receipts for deleted items without silently accepting corrupt metadata', async () => {
  for (let i = 0; i < 30; i++) {
    const result = await service.addChecklistItem(id, `Task ${i}`, `request-${i}`)
    await service.removeChecklistItem(id, result.taskItemId)
  }
  const project = repo.readProject(id)!
  expect(parseProject(serializeProject(project)).operations).toHaveLength(30)
  expect(serializeProject(project).length).toBeLessThan(15000)
  expect(() => parseProject(serializeProject({ ...project, operations: [{}] } as never))).toThrow()
  await expect(service.addChecklistItem(id, 'Task', '' )).rejects.toMatchObject({ status: 400 })
  await expect(service.addChecklistItem(id, '   ', 'request-valid')).rejects.toMatchObject({ status: 400 })
})


it('coalesces concurrent promotions and permits hooks to reenter the project service', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const create = setup.ctx.tasks.create
  let calls = 0
  setup.ctx.tasks.create = async input => {
    calls++
    await service.updateProject(id, { owner: 'hook-agent' })
    return create(input)
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => service.promoteItemToTask(id, taskItemId, { requestId: 'promote-request' })))
  expect(new Set(results.map(result => result.taskId)).size).toBe(1)
  expect(calls).toBe(1)
  expect(repo.readProject(id)?.owner).toBe('hook-agent')
})

it('resumes a failed link after reconstruction without creating another board task', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const write = repo.writeProject
  let writes = 0
  repo.writeProject = project => { if (++writes === 2) throw new Error('link write failed'); write(project) }
  await expect(service.promoteItemToTask(id, taskItemId, { requestId: 'promote-request' })).rejects.toThrow('link write failed')
  expect(await setup.ctx.tasks.list()).toHaveLength(1)
  service = createProjectService(setup.ctx, createProjectRepository(setup.ctx.storage))
  const recovered = await service.promoteItemToTask(id, taskItemId, { requestId: 'promote-request' })
  expect(await setup.ctx.tasks.list()).toHaveLength(1)
  expect(repo.readProject(id)?.tasks[0]?.taskId).toBe(recovered.taskId)
  await expect(service.promoteItemToTask(id, taskItemId, { requestId: 'promote-request', assignee: 'different' })).rejects.toMatchObject({ status: 409 })
})

it('reports a downstream create failure and later reconciles the exact reserved task', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const create = setup.ctx.tasks.create
  setup.ctx.tasks.create = async input => { await create(input); throw new Error('downstream hook failed') }
  await expect(service.promoteItemToTask(id, taskItemId)).rejects.toThrow('downstream hook failed')
  expect(repo.readProject(id)?.tasks[0]?.taskId).toBeUndefined()
  const result = await service.promoteItemToTask(id, taskItemId)
  expect(await setup.ctx.tasks.list()).toHaveLength(1)
  expect(repo.readProject(id)?.tasks[0]?.taskId).toBe(result.taskId)
})

it('does not link a replacement item or resurrect a deleted project after creation', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const create = setup.ctx.tasks.create
  setup.ctx.tasks.create = async input => {
    const task = await create(input)
    await service.removeChecklistItem(id, taskItemId)
    await service.addChecklistItem(id, 'Replacement')
    return task
  }
  await expect(service.promoteItemToTask(id, taskItemId, { requestId: 'promote-request' })).rejects.toMatchObject({ status: 409 })
  await expect(service.promoteItemToTask(id, taskItemId, { requestId: 'promote-request' })).rejects.toMatchObject({ status: 409 })
  expect(repo.readProject(id)?.tasks[0]?.taskId).toBeUndefined()
  expect(await setup.ctx.tasks.list()).toHaveLength(1)
})

it('rejects a foreign task collision and never recreates a deleted completed promotion', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const get = setup.ctx.tasks.get
  setup.ctx.tasks.get = async taskId => ({ id: taskId, projectId: 'foreign', source: {} }) as never
  await expect(service.promoteItemToTask(id, taskItemId)).rejects.toMatchObject({ status: 409 })
  expect(await setup.ctx.tasks.list()).toHaveLength(0)
  setup.ctx.tasks.get = get
  const result = await service.promoteItemToTask(id, taskItemId)
  await setup.ctx.tasks.remove(result.taskId)
  await service.autoUnlinkTask(result.taskId)
  await expect(service.promoteItemToTask(id, taskItemId)).rejects.toMatchObject({ status: 409 })
  expect(await setup.ctx.tasks.list()).toHaveLength(0)
})


it('does not create a task before the reservation is durable', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const write = repo.writeProject
  repo.writeProject = () => { throw new Error('reservation failed') }
  await expect(service.promoteItemToTask(id, taskItemId)).rejects.toThrow('reservation failed')
  expect(await setup.ctx.tasks.list()).toHaveLength(0)
  repo.writeProject = write
  await service.promoteItemToTask(id, taskItemId)
  expect(await setup.ctx.tasks.list()).toHaveLength(1)
})

it('does not recreate a project deleted by a task hook', async () => {
  const { taskItemId } = await service.addChecklistItem(id, 'Promote')
  const create = setup.ctx.tasks.create
  setup.ctx.tasks.create = async input => {
    const task = await create(input)
    await service.deleteProject(id)
    return task
  }
  await expect(service.promoteItemToTask(id, taskItemId)).rejects.toMatchObject({ status: 409 })
  expect(repo.readProject(id)).toBeNull()
  expect(await setup.ctx.tasks.list()).toHaveLength(1)
})
