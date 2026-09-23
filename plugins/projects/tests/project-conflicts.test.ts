import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectRepository } from '../lib/parser'
import { createProjectService } from '../lib/project-service'
import { createTestContext } from '../test-helpers'

let root: string
let repo: ReturnType<typeof createProjectRepository>
let service: ReturnType<typeof createProjectService>
let id: string
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'project-conflicts-'))
  const { ctx } = createTestContext('projects', root)
  repo = createProjectRepository(ctx.storage)
  service = createProjectService(ctx, repo)
  id = (await service.createProject({ title: 'Original', body: 'Original body', owner: 'main' })).id
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('atomic expected-value updates', () => {
  it('merges disjoint updates but rejects overlapping fields without partial writes', async () => {
    await service.updateProject(id, { owner: 'agent' }, 'agent')
    await service.updateProject(id, { title: 'Mine' }, undefined, { title: 'Original' })
    expect(repo.readProject(id)?.owner).toBe('agent')
    await expect(service.updateProject(id, { title: 'Stale', body: 'Do not save' }, undefined, { title: 'Original', body: 'Original body' })).rejects.toMatchObject({
      status: 409, code: 'field_conflict', conflicts: { title: { expected: 'Original', current: 'Mine', requested: 'Stale' } },
    })
    expect(repo.readProject(id)?.body).toBe('Original body')
    expect(repo.readPlanHistory(id)).toEqual([])
  })

  it('accepts equal-value convergence without duplicate snapshots', async () => {
    await service.updateProject(id, { body: 'Same result' }, 'agent')
    const timestamp = repo.readProject(id)?.updated
    await service.updateProject(id, { body: 'Same result' }, undefined, { body: 'Original body' })
    expect(repo.readPlanHistory(id)).toHaveLength(1)
    expect(repo.readProject(id)?.updated).toBe(timestamp)
  })

  it('serializes concurrent saves and rechecks the latest reviewed value on retry', async () => {
    const results = await Promise.allSettled([
      service.updateProject(id, { title: 'First' }, undefined, { title: 'Original' }),
      service.updateProject(id, { title: 'Second' }, undefined, { title: 'Original' }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await service.updateProject(id, { title: 'Third' }, 'agent')
    await expect(service.updateProject(id, { title: 'Second' }, undefined, { title: 'First' })).rejects.toMatchObject({ status: 409 })
  })

  it('rejects malformed or incomplete intent before changing any fields', async () => {
    await expect(service.updateProject(id, { title: 'Valid', body: 42 } as never)).rejects.toMatchObject({ status: 400 })
    await expect(service.updateProject(id, { title: 'Valid', body: 'New' }, undefined, { title: 'Original' })).rejects.toMatchObject({ status: 400 })
    await expect(service.updateProject(id, { title: '   ' })).rejects.toMatchObject({ status: 400 })
    expect(repo.readProject(id)?.title).toBe('Original')
    expect(repo.readPlanHistory(id)).toEqual([])
  })

  it('protects checklist descriptions and reports removed items', async () => {
    const { taskItemId } = await service.addChecklistItem(id, 'Task')
    await service.updateChecklistItem(id, taskItemId, { description: 'Agent draft' })
    await expect(service.updateChecklistItem(id, taskItemId, { title: 'Mine', description: 'My draft' }, { title: 'Task', description: '' })).rejects.toMatchObject({ status: 409 })
    expect(repo.readProject(id)?.tasks[0]?.title).toBe('Task')
    await service.removeChecklistItem(id, taskItemId)
    await expect(service.updateChecklistItem(id, taskItemId, { description: 'Resurrect' }, { description: 'Agent draft' })).rejects.toMatchObject({ status: 404 })
  })
})
