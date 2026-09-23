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
