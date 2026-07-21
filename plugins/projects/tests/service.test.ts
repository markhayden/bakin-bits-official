import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = join(tmpdir(), `bakin-test-projects-svc-${Date.now()}`)
const projectsDir = join(testDir, 'projects')

const mockTaskboardColumns = {
  todo: [{ id: 'board01', title: 'Board Task 1' }],
  inProgress: [],
  review: [],
  done: [{ id: 'board02', title: 'Done Task' }],
  archived: [],
  blocked: [],
  backlog: [],
}

// Suppress broadcast
;(globalThis as any).__bakinBroadcast = mock()

// Clear project index between tests
function clearIndex() {
  ;(globalThis as any).__bakinProjectIndex = undefined
  ;(globalThis as any).__bakinProjectLock = undefined
}

import { createProjectService, type ProjectService } from '../../../plugins/projects/lib/project-service'
import { createProjectRepository, type ProjectRepository } from '../../../plugins/projects/lib/parser'
import { MarkdownStorageAdapter } from '../test-helpers'
import type { PluginContext } from '@makinbakin/sdk/types'

let service: ProjectService
let repo: ProjectRepository
let createProject: ProjectService['createProject']
let updateProject: ProjectService['updateProject']
let deleteProject: ProjectService['deleteProject']
let addChecklistItem: ProjectService['addChecklistItem']
let markChecklistItem: ProjectService['markChecklistItem']
let updateChecklistItem: ProjectService['updateChecklistItem']
let removeChecklistItem: ProjectService['removeChecklistItem']
let linkChecklistItem: ProjectService['linkChecklistItem']
let promoteItemToTask: ProjectService['promoteItemToTask']
let attachAsset: ProjectService['attachAsset']
let relinkAsset: ProjectService['relinkAsset']
let detachAsset: ProjectService['detachAsset']
let autoCheckLinkedItem: ProjectService['autoCheckLinkedItem']
let autoUnlinkTask: ProjectService['autoUnlinkTask']
let rebuildIndex: ProjectService['rebuildIndex']
let getProjectForTask: ProjectService['getProjectForTask']
let getProjectTitleForTask: ProjectService['getProjectTitleForTask']
let resolveLinkedTaskStatuses: ProjectService['resolveLinkedTaskStatuses']
let readProject: ProjectRepository['readProject']
let ctx: PluginContext

function testAssetSummary(assetId: string) {
  return {
    assetId,
    type: 'images' as const,
    agent: 'pixel',
    taskId: null,
    created: '2026-04-01T00:00:00.000Z',
    updated: '2026-04-01T00:00:00.000Z',
    currentVersion: 1,
    versionCount: 1,
    description: '',
    tags: [],
    mimeType: 'image/png',
    width: null,
    height: null,
    size: 1,
    hasThumb: false,
  }
}

function buildCtx(): PluginContext {
  const tasks = Object.values(mockTaskboardColumns).flat().map((task) => ({
    ...task,
    checked: task.id === 'board02',
    column: task.id === 'board02' ? 'done' as const : 'todo' as const,
  }))
  return {
    pluginId: 'projects',
    storage: new MarkdownStorageAdapter(testDir),
    runtime: {} as PluginContext['runtime'],
    events: {} as PluginContext['events'],
    tasks: {
      create: mock(async () => ({ id: 'newtask1', title: 'New task', checked: false, column: 'todo' as const })),
      update: mock(async () => ({ id: 'newtask1', title: 'New task', checked: false, column: 'todo' as const })),
      move: mock(async () => ({ id: 'newtask1', title: 'New task', checked: false, column: 'todo' as const })),
      remove: mock(async () => {}),
      get: mock(async () => null),
      list: mock(async () => tasks),
      appendLog: mock(async () => {}),
    },
    assets: {
      createAsset: mock(async () => ({ assetId: 'test-asset', version: 1 })),
      getAsset: mock(async (assetId: string) => testAssetSummary(assetId)),
      addVersion: mock(async () => ({ assetId: 'test-asset', version: 2 })),
      addExport: mock(async () => ({ name: 'export', file: 'exports/export.jpg' })),
      resolveVersionFile: mock(async () => null),
    },
    registerNav: mock(),
    registerRoute: mock(),
    registerSlot: mock(),
    registerExecTool: mock(),
    registerSkill: mock(),
    registerWorkflow: mock(),
    registerNodeType: mock(() => ''),
    registerNotificationChannel: mock(() => ''),
    registerHealthCheck: mock(() => ''),
    watchFiles: mock(),
    getSettings: (() => ({})) as PluginContext['getSettings'],
    updateSettings: mock(),
    activity: { log: mock(), audit: mock() },
    search: {} as PluginContext['search'],
    hooks: { register: mock(() => () => {}), has: mock(() => false), invoke: mock(async () => undefined) },
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(projectsDir, { recursive: true })
  clearIndex()
  repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
  ctx = buildCtx()
  service = createProjectService(ctx, repo)
  ;({
    createProject,
    updateProject,
    deleteProject,
    addChecklistItem,
    markChecklistItem,
    updateChecklistItem,
    removeChecklistItem,
    linkChecklistItem,
    promoteItemToTask,
    attachAsset,
    relinkAsset,
    detachAsset,
    autoCheckLinkedItem,
    autoUnlinkTask,
    rebuildIndex,
    getProjectForTask,
    getProjectTitleForTask,
    resolveLinkedTaskStatuses,
  } = service)
  readProject = repo.readProject
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('createProject', () => {
  it('creates a project file and returns id', async () => {
    const result = await createProject({ title: 'New Project' })
    expect(result.id).toBeDefined()
    expect(result.id.length).toBe(8)

    const project = readProject(result.id)
    expect(project).not.toBeNull()
    expect(project!.title).toBe('New Project')
    expect(project!.status).toBe('draft')
    expect(project!.owner).toBe('main')
    expect(project!.body).toBe('')
  })

  it('creates initial checklist items', async () => {
    const result = await createProject({ title: 'With Tasks', tasks: ['Task A', 'Task B'] })
    expect(result.taskItems).toHaveLength(2)
    expect(result.taskItems[0].title).toBe('Task A')
    expect(result.taskItems[1].title).toBe('Task B')

    const project = readProject(result.id)
    expect(project!.tasks).toHaveLength(2)
    expect(project!.tasks[0].id).toBe('t001')
    expect(project!.tasks[1].id).toBe('t002')
  })

  it('accepts optional body and owner', async () => {
    const result = await createProject({ title: 'Custom', body: '# Hello', owner: 'scout' })
    const project = readProject(result.id)
    expect(project!.body).toBe('# Hello')
    expect(project!.owner).toBe('scout')
  })
})

describe('updateProject', () => {
  it('updates title and status', async () => {
    const { id } = await createProject({ title: 'Original' })
    await updateProject(id, { title: 'Updated', status: 'active' })

    const project = readProject(id)
    expect(project!.title).toBe('Updated')
    expect(project!.status).toBe('active')
  })

  it('prevents completing with unchecked items', async () => {
    const { id } = await createProject({ title: 'Incomplete', tasks: ['Task'] })
    await expect(updateProject(id, { status: 'completed' })).rejects.toThrow('unchecked items')
  })

  it('allows completing when all items checked', async () => {
    const { id } = await createProject({ title: 'Complete', tasks: ['Task'] })
    await markChecklistItem(id, 't001', true)
    await updateProject(id, { status: 'completed' })

    const project = readProject(id)
    expect(project!.status).toBe('completed')
  })

  it('throws for non-existent project', async () => {
    await expect(updateProject('nonexistent', { title: 'Nope' })).rejects.toThrow('not found')
  })
})

describe('deleteProject', () => {
  it('deletes a project', async () => {
    const { id } = await createProject({ title: 'To Delete' })
    await deleteProject(id)
    expect(readProject(id)).toBeNull()
  })

  it('throws for non-existent project', async () => {
    await expect(deleteProject('nonexistent')).rejects.toThrow('not found')
  })
})

// ---------------------------------------------------------------------------
// Checklist operations
// ---------------------------------------------------------------------------

describe('addChecklistItem', () => {
  it('adds an item and updates progress', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Existing'] })
    await markChecklistItem(id, 't001', true)

    const { taskItemId } = await addChecklistItem(id, 'New Item')
    expect(taskItemId).toBe('t002')

    const project = readProject(id)
    expect(project!.tasks).toHaveLength(2)
    expect(project!.tasks[1].title).toBe('New Item')
    expect(project!.progress).toBe(50) // 1 of 2 checked
  })
})

describe('markChecklistItem', () => {
  it('checks and unchecks items', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['A', 'B'] })

    await markChecklistItem(id, 't001', true)
    let project = readProject(id)
    expect(project!.tasks[0].checked).toBe(true)
    expect(project!.progress).toBe(50)

    await markChecklistItem(id, 't001', false)
    project = readProject(id)
    expect(project!.tasks[0].checked).toBe(false)
    expect(project!.progress).toBe(0)
  })

  it('auto-completes active project when all checked', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Only'] })
    await updateProject(id, { status: 'active' })

    await markChecklistItem(id, 't001', true)
    const project = readProject(id)
    expect(project!.status).toBe('completed')
    expect(project!.progress).toBe(100)
  })

  it('does not auto-complete draft projects', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Only'] })

    await markChecklistItem(id, 't001', true)
    const project = readProject(id)
    expect(project!.status).toBe('draft') // stays draft
  })
})

describe('updateChecklistItem', () => {
  it('updates title and description', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Original'] })
    await updateChecklistItem(id, 't001', { title: 'Renamed', description: 'Details here' })

    const project = readProject(id)
    expect(project!.tasks[0].title).toBe('Renamed')
    expect(project!.tasks[0].description).toBe('Details here')
  })

  it('clears description with empty string', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Task'] })
    await updateChecklistItem(id, 't001', { description: 'First' })
    await updateChecklistItem(id, 't001', { description: '' })

    const project = readProject(id)
    expect(project!.tasks[0].description).toBeUndefined()
  })
})

describe('removeChecklistItem', () => {
  it('removes an item and updates progress', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['A', 'B'] })
    await markChecklistItem(id, 't001', true)

    await removeChecklistItem(id, 't001')
    const project = readProject(id)
    expect(project!.tasks).toHaveLength(1)
    expect(project!.tasks[0].title).toBe('B')
    expect(project!.progress).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Task linking
// ---------------------------------------------------------------------------

describe('linkChecklistItem', () => {
  it('links a board task to a checklist item', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Task'] })
    await linkChecklistItem(id, 't001', 'board01')

    const project = readProject(id)
    expect(project!.tasks[0].taskId).toBe('board01')
  })
})

describe('promoteItemToTask', () => {
  it('creates a board task and links it', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Promote me'] })
    const result = await promoteItemToTask(id, 't001')

    expect(result.taskId).toBe('newtask1')

    const project = readProject(id)
    expect(project!.tasks[0].taskId).toBe('newtask1')
  })

  it('rejects if already linked', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Linked'] })
    await linkChecklistItem(id, 't001', 'existing')

    await expect(promoteItemToTask(id, 't001')).rejects.toThrow('already linked')
  })
})

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

describe('rebuildIndex / getProjectForTask / getProjectTitleForTask', () => {
  it('indexes linked tasks', async () => {
    const { id } = await createProject({ title: 'Indexed', tasks: ['Task'] })
    await linkChecklistItem(id, 't001', 'board01')

    rebuildIndex()

    const entry = getProjectForTask('board01')
    expect(entry).toBeDefined()
    expect(entry!.projectId).toBe(id)
    expect(entry!.taskItemId).toBe('t001')

    const title = getProjectTitleForTask('board01')
    expect(title).toBe('Indexed')
  })

  it('returns undefined for unlinked tasks', () => {
    rebuildIndex()
    expect(getProjectForTask('nonexistent')).toBeUndefined()
    expect(getProjectTitleForTask('nonexistent')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Auto-check / Auto-unlink
// ---------------------------------------------------------------------------

describe('autoCheckLinkedItem', () => {
  it('checks the linked item when board task completes', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Auto'] })
    await linkChecklistItem(id, 't001', 'board01')
    rebuildIndex()

    await autoCheckLinkedItem('board01')

    const project = readProject(id)
    expect(project!.tasks[0].checked).toBe(true)
  })

  it('no-ops for unlinked board tasks', async () => {
    await autoCheckLinkedItem('unlinked')
    // Should not throw
  })
})

describe('autoUnlinkTask', () => {
  it('unlinks and unchecks when board task is deleted', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['Unlink'] })
    await linkChecklistItem(id, 't001', 'board01')
    await markChecklistItem(id, 't001', true)
    rebuildIndex()

    await autoUnlinkTask('board01')

    const project = readProject(id)
    expect(project!.tasks[0].taskId).toBeUndefined()
    expect(project!.tasks[0].checked).toBe(false)
    expect(getProjectForTask('board01')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

describe('attachAsset / detachAsset', () => {
  it('attaches and detaches assets', async () => {
    const { id } = await createProject({ title: 'P' })

    await attachAsset(id, '20260401-logo-a1b2c3d4', 'Logo')
    let project = readProject(id)
    expect(project!.assets).toHaveLength(1)
    expect(project!.assets[0]).toEqual({ assetId: '20260401-logo-a1b2c3d4', label: 'Logo' })

    // Duplicate attach is ignored
    await attachAsset(id, '20260401-logo-a1b2c3d4')
    project = readProject(id)
    expect(project!.assets).toHaveLength(1)

    await detachAsset(id, '20260401-logo-a1b2c3d4')
    project = readProject(id)
    expect(project!.assets).toHaveLength(0)
  })

  it('rejects asset attachments that do not exist', async () => {
    const { id } = await createProject({ title: 'P' })
    ctx.assets.getAsset = mock(async () => null) as typeof ctx.assets.getAsset

    await expect(attachAsset(id, '20260401-missing-a1b2c3d4')).rejects.toThrow('Asset not found')
    expect(readProject(id)!.assets).toEqual([])
  })

  it('detach no-ops for unattached asset', async () => {
    const { id } = await createProject({ title: 'P' })
    await detachAsset(id, 'nonexistent')
    // Should not throw
  })

  it('relinks an existing asset reference to a replacement asset', async () => {
    const { id } = await createProject({ title: 'P' })
    await attachAsset(id, '20260401-deleted-a1b2c3d4', 'Hero reference')

    await relinkAsset(id, '20260401-deleted-a1b2c3d4', '20260401-hero-e5f6g7h8')

    expect(readProject(id)!.assets).toEqual([
      { assetId: '20260401-hero-e5f6g7h8', label: 'Hero reference' },
    ])
  })

  it('relink removes the old reference when the replacement is already attached', async () => {
    const { id } = await createProject({ title: 'P' })
    await attachAsset(id, '20260401-deleted-a1b2c3d4', 'Deleted')
    await attachAsset(id, '20260401-hero-e5f6g7h8', 'Hero')

    await relinkAsset(id, '20260401-deleted-a1b2c3d4', '20260401-hero-e5f6g7h8')

    expect(readProject(id)!.assets).toEqual([
      { assetId: '20260401-hero-e5f6g7h8', label: 'Hero' },
    ])
  })
})

// ---------------------------------------------------------------------------
// resolveLinkedTaskStatuses
// ---------------------------------------------------------------------------

describe('resolveLinkedTaskStatuses', () => {
  it('resolves linked task columns', async () => {
    const { id } = await createProject({ title: 'P', tasks: ['A', 'B'] })
    await linkChecklistItem(id, 't001', 'board01')
    await linkChecklistItem(id, 't002', 'missing99')

    const project = readProject(id)!
    const resolved = await resolveLinkedTaskStatuses(project)

    expect(resolved.resolvedTasks['board01']).toEqual({ column: 'todo', title: 'Board Task 1' })
    expect(resolved.resolvedTasks['missing99']).toBeNull() // not found on board
  })

  it('marks deleted assets missing without failing the project', async () => {
    const { id } = await createProject({ title: 'P' })
    await attachAsset(id, '20260401-logo-a1b2c3d4', 'Logo')
    ctx.assets.getAsset = mock(async () => null) as typeof ctx.assets.getAsset

    const resolved = await resolveLinkedTaskStatuses(readProject(id)!)

    expect(resolved.resolvedAssets).toEqual([
      { assetId: '20260401-logo-a1b2c3d4', label: 'Logo', type: 'unknown', missing: true },
    ])
  })

  it('marks assets missing when the asset API is unavailable', async () => {
    const { id } = await createProject({ title: 'P' })
    await attachAsset(id, '20260401-logo-a1b2c3d4', 'Logo')
    delete (ctx.assets as Partial<typeof ctx.assets>).getAsset

    const resolved = await resolveLinkedTaskStatuses(readProject(id)!)

    expect(resolved.resolvedAssets).toEqual([
      { assetId: '20260401-logo-a1b2c3d4', label: 'Logo', type: 'unknown', missing: true },
    ])
  })

  it('marks an asset missing when resolving it throws', async () => {
    const { id } = await createProject({ title: 'P' })
    await attachAsset(id, '20260401-logo-a1b2c3d4', 'Logo')
    ctx.assets.getAsset = mock(async () => { throw new Error('asset store unavailable') }) as typeof ctx.assets.getAsset

    const resolved = await resolveLinkedTaskStatuses(readProject(id)!)

    expect(resolved.resolvedAssets).toEqual([
      { assetId: '20260401-logo-a1b2c3d4', label: 'Logo', type: 'unknown', missing: true },
    ])
  })

  it('keeps legacy filename asset references removable', async () => {
    writeFileSync(join(projectsDir, 'legacy.md'), `---
id: legacy
title: Legacy
status: active
created: "2026-04-01T00:00:00.000Z"
updated: "2026-04-01T00:00:00.000Z"
owner: main
tasks: []
assets:
  - filename: deleted-image.png
    label: Deleted image
---

# Legacy
`)
    ctx.assets.getAsset = mock(async () => null) as typeof ctx.assets.getAsset

    const resolved = await resolveLinkedTaskStatuses(readProject('legacy')!)

    expect(resolved.resolvedAssets).toEqual([
      { assetId: 'deleted-image.png', label: 'Deleted image', type: 'unknown', missing: true },
    ])

    await detachAsset('legacy', 'deleted-image.png')
    expect(readProject('legacy')!.assets).toEqual([])
  })
})

describe('plan history (bakin#703)', () => {
  it('snapshots the PRIOR body on agent and user edits, with attribution; no-op writes never snapshot', async () => {
    const { id } = await createProject({ title: 'History', body: 'v1' })
    await service.applyProjectPlan(id, { body: 'v2' })          // agent edit
    await updateProject(id, { body: 'v3' })                     // user edit (no agent arg)
    await updateProject(id, { body: 'v3' })                     // no-op — must not snapshot
    await updateProject(id, { title: 'Renamed' })               // body untouched — no snapshot

    const history = repo.readPlanHistory(id)
    expect(history.map((s) => ({ author: s.author, body: s.body }))).toEqual([
      { author: 'agent', body: 'v1' },
      { author: 'user', body: 'v2' },
    ])
    expect(repo.readProject(id)?.body).toBe('v3')
  })

  it('appendBody changes snapshot too', async () => {
    const { id } = await createProject({ title: 'Append', body: 'base' })
    await service.applyProjectPlan(id, { appendBody: 'more' })
    const history = repo.readPlanHistory(id)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ author: 'agent', body: 'base' })
    expect(repo.readProject(id)?.body).toBe('base\n\nmore')
  })

  it('caps history at 20 snapshots, dropping the oldest', async () => {
    const { id } = await createProject({ title: 'Capped', body: 'v0' })
    for (let i = 1; i <= 25; i++) {
      await updateProject(id, { body: `v${i}` })
    }
    const history = repo.readPlanHistory(id)
    expect(history).toHaveLength(20)
    expect(history[0].body).toBe('v5')   // v0..v4 dropped
    expect(history[19].body).toBe('v24')
  })

  it('restore snapshots the current body first (never destructive) and applies the chosen version', async () => {
    const { id } = await createProject({ title: 'Restore', body: 'first' })
    await service.applyProjectPlan(id, { body: 'second' })
    await service.applyProjectPlan(id, { body: 'third' })

    await service.restorePlanVersion(id, 0) // back to 'first'
    expect(repo.readProject(id)?.body).toBe('first')
    const history = repo.readPlanHistory(id)
    // first, second, then 'third' pushed by the restore itself.
    expect(history.map((s) => s.body)).toEqual(['first', 'second', 'third'])
    expect(history[2]).toMatchObject({ author: 'user' })

    await expect(service.restorePlanVersion(id, 99)).rejects.toThrow(/No plan snapshot/)
    await expect(service.restorePlanVersion('ghost', 0)).rejects.toThrow(/not found/i)
  })

  it('deleting a project removes its history sidecar', async () => {
    const { id } = await createProject({ title: 'Gone', body: 'a' })
    await updateProject(id, { body: 'b' })
    expect(repo.readPlanHistory(id)).toHaveLength(1)
    await deleteProject(id)
    expect(repo.readPlanHistory(id)).toEqual([])
  })
})
