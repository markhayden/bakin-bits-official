/**
 * Projects plugin — route and exec tool integration tests.
 * Activates the plugin with a mock PluginContext, then exercises every
 * registered HTTP route and MCP exec tool.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import {
  activatePlugin,
  findRoute,
  findTool,
  callRoute,
  callTool,
  callSearchRoute,
} from '../test-helpers'
import type { ActivatedPlugin } from '../test-helpers'
import type {
  RuntimeChatChunk as ChatChunk,
  RuntimeMessageArgs as MessageArgs,
  RuntimeMessageResult as MessageResult,
} from '@makinbakin/sdk/types'

// ---------------------------------------------------------------------------
// Test directory
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `bakin-test-projects-routes-${Date.now()}`)
const projectsDir = join(testDir, 'projects')

/** Consume an SSE Response body into a list of {event, data} records. */
type ProjectRouteTestGlobal = typeof globalThis & {
  __bakinBroadcast?: unknown
  __bakinProjectIndex?: unknown
  __bakinProjectLock?: unknown
}

const testGlobal = globalThis as ProjectRouteTestGlobal

// Suppress SSE broadcast
testGlobal.__bakinBroadcast = mock()

// Clear project index / lock between tests
function clearGlobals() {
  testGlobal.__bakinProjectIndex = undefined
  testGlobal.__bakinProjectLock = undefined
}

// ---------------------------------------------------------------------------
// Plugin import (after mocks)
// ---------------------------------------------------------------------------

import projectsPlugin from '../../../plugins/projects'
import { createProjectRepository } from '../../../plugins/projects/lib/parser'
import { MarkdownStorageAdapter } from '../test-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a project markdown file directly on disk for read-only tests. */
function writeProjectFixture(
  id: string,
  opts: { title?: string; status?: string; tasks?: Array<{ id: string; title: string; checked: boolean; taskId?: string }>; assets?: Array<{ assetId: string; label?: string }>; body?: string; owner?: string } = {},
) {
  const title = opts.title ?? `Project ${id}`
  const status = opts.status ?? 'active'
  const owner = opts.owner ?? 'main'
  const tasks = opts.tasks ?? []
  const assets = opts.assets ?? []
  const body = opts.body ?? `# ${title}\nProject body text.`
  const now = new Date().toISOString()

  const fm: Record<string, unknown> = {
    id,
    title,
    status,
    created: now,
    updated: now,
    owner,
    tasks: tasks.map(t => {
      const item: Record<string, unknown> = { id: t.id, title: t.title, checked: t.checked }
      if (t.taskId) item.taskId = t.taskId
      return item
    }),
  }
  if (assets.length > 0) fm.assets = assets

  const content = `---\n${yaml.dump(fm, { lineWidth: -1 }).trim()}\n---\n\n${body}\n`
  if (!existsSync(projectsDir)) mkdirSync(projectsDir, { recursive: true })
  writeFileSync(join(projectsDir, `${id}.md`), content, 'utf-8')
}

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

const KNOWN_ASSET_IDS = new Set([
  '20260401-spec-abcdef12',
  '20260401-logo-abcdef12',
  '20260401-brief-abcdef12',
  '20260401-x-abcdef12',
])

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let plugin: ActivatedPlugin

async function* streamTextChunks(tokens: string[]): AsyncIterable<ChatChunk> {
  for (const token of tokens) {
    yield { type: 'text', content: token }
  }
}

async function* streamChunks(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const chunk of chunks) yield chunk
}

function mockRuntimeStream(tokens: string[]) {
  const streamMock = mock((args: MessageArgs) => {
    void args
    return streamTextChunks(tokens)
  })
  plugin.ctx.runtime.messaging.stream = streamMock
  return streamMock
}

function mockRuntimeChunks(chunks: ChatChunk[]) {
  const streamMock = mock((args: MessageArgs) => {
    void args
    return streamChunks(chunks)
  })
  plugin.ctx.runtime.messaging.stream = streamMock
  return streamMock
}

function mockRuntimeStreamError(message: string) {
  const streamMock = mock((args: MessageArgs): AsyncIterable<ChatChunk> => {
    void args
    throw new Error(message)
  })
  plugin.ctx.runtime.messaging.stream = streamMock
  return streamMock
}

beforeEach(async () => {
  clearGlobals()
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  mkdirSync(projectsDir, { recursive: true })
  plugin = await activatePlugin(projectsPlugin, testDir)
  plugin.ctx.assets.getAsset = mock(async (assetId: string) => (
    KNOWN_ASSET_IDS.has(assetId) ? testAssetSummary(assetId) : null
  )) as typeof plugin.ctx.assets.getAsset
})

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
})

// ===========================================================================
// ROUTES
// ===========================================================================

describe('Routes', () => {
  // -------------------------------------------------------------------------
  // GET / — list projects
  // -------------------------------------------------------------------------
  describe('GET / — list projects', () => {
    it('returns empty list when no projects exist', async () => {
      const route = findRoute(plugin.routes, 'GET', '/')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx)
      expect(status).toBe(200)
      expect(body.projects).toEqual([])
    })

    it('returns project summaries', async () => {
      writeProjectFixture('proj-aaa', { title: 'Alpha', tasks: [{ id: 't001', title: 'Do thing', checked: false }] })
      writeProjectFixture('proj-bbb', { title: 'Beta', status: 'completed' })

      const route = findRoute(plugin.routes, 'GET', '/')!
      const { status, body } = await callRoute(route, plugin.ctx)
      expect(status).toBe(200)
      const projects = body.projects as Array<Record<string, unknown>>
      expect(projects).toHaveLength(2)
      expect(projects.map(p => p.title)).toContain('Alpha')
      expect(projects.map(p => p.title)).toContain('Beta')
    })

    it('filters by status query param', async () => {
      writeProjectFixture('proj-aaa', { title: 'Active One', status: 'active' })
      writeProjectFixture('proj-bbb', { title: 'Draft One', status: 'draft' })

      const route = findRoute(plugin.routes, 'GET', '/')!
      const { body } = await callRoute(route, plugin.ctx, { searchParams: { status: 'draft' } })
      const projects = body.projects as Array<Record<string, unknown>>
      expect(projects).toHaveLength(1)
      expect(projects[0].title).toBe('Draft One')
    })
  })

  // -------------------------------------------------------------------------
  // GET /:projectId — get single project
  // -------------------------------------------------------------------------
  describe('GET /:projectId — get project', () => {
    it('returns a project by ID', async () => {
      writeProjectFixture('proj-001', { title: 'My Project', tasks: [{ id: 't001', title: 'Step 1', checked: false }] })

      const route = findRoute(plugin.routes, 'GET', '/:projectId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, { searchParams: { projectId: 'proj-001' } })
      expect(status).toBe(200)
      const project = body.project as Record<string, unknown>
      expect(project.title).toBe('My Project')
      expect(project.id).toBe('proj-001')
    })

    it('returns 400 when id is missing', async () => {
      const route = findRoute(plugin.routes, 'GET', '/:projectId')!
      const { status, body } = await callRoute(route, plugin.ctx)
      expect(status).toBe(400)
      expect(body.error).toMatch(/[Mm]issing/)
    })

    it('returns 404 when project does not exist', async () => {
      const route = findRoute(plugin.routes, 'GET', '/:projectId')!
      const { status, body } = await callRoute(route, plugin.ctx, { searchParams: { projectId: 'nonexistent' } })
      expect(status).toBe(404)
      expect(body.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // POST / — create project
  // -------------------------------------------------------------------------
  describe('POST / — create project', () => {
    it('creates a project and returns its id', async () => {
      const route = findRoute(plugin.routes, 'POST', '/')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        body: { title: 'New Project', owner: 'scout' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.id).toBeDefined()
      expect(typeof body.id).toBe('string')
    })

    it('creates with initial tasks', async () => {
      const route = findRoute(plugin.routes, 'POST', '/')!
      const { body } = await callRoute(route, plugin.ctx, {
        body: { title: 'With Tasks', tasks: ['Step 1', 'Step 2'] },
      })
      expect(body.ok).toBe(true)
      const items = body.taskItems as Array<Record<string, unknown>>
      expect(items).toHaveLength(2)
      expect(items[0].title).toBe('Step 1')
    })

    it('returns 400 when title is missing', async () => {
      const route = findRoute(plugin.routes, 'POST', '/')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        body: {},
      })
      expect(status).toBe(400)
      expect(body.error).toMatch(/[Mm]issing title/)
    })

    it('records audit activity', async () => {
      const route = findRoute(plugin.routes, 'POST', '/')!
      await callRoute(route, plugin.ctx, { body: { title: 'Audited' } })
      expect(plugin.ctx.activity.audit).toHaveBeenCalledWith(
        'created',
        expect.any(String),
        expect.objectContaining({ title: 'Audited' }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // PUT /:projectId — update project
  // -------------------------------------------------------------------------
  describe('PUT /:projectId — update project', () => {
    it('updates title and status', async () => {
      writeProjectFixture('proj-upd', { title: 'Old Title', status: 'draft' })

      const route = findRoute(plugin.routes, 'PUT', '/:projectId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-upd' },
        body: { title: 'New Title', status: 'active' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    })

    it('returns 400 when id is missing', async () => {
      const route = findRoute(plugin.routes, 'PUT', '/:projectId')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        body: { title: 'No Id' },
      })
      expect(status).toBe(400)
      expect(body.error).toMatch(/[Mm]issing/)
    })

    it('returns 400 for non-existent project', async () => {
      const route = findRoute(plugin.routes, 'PUT', '/:projectId')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'ghost' },
        body: { title: 'Nope' },
      })
      expect(status).toBe(400)
      expect(body.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /:projectId — delete project
  // -------------------------------------------------------------------------
  describe('DELETE /:projectId — delete project', () => {
    it('deletes a project', async () => {
      writeProjectFixture('proj-del', { title: 'Delete Me' })

      const route = findRoute(plugin.routes, 'DELETE', '/:projectId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-del' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(existsSync(join(projectsDir, 'proj-del.md'))).toBe(false)
    })

    it('returns 400 when id is missing', async () => {
      const route = findRoute(plugin.routes, 'DELETE', '/:projectId')!
      const { status } = await callRoute(route, plugin.ctx)
      expect(status).toBe(400)
    })

    it('returns 400 for non-existent project', async () => {
      const route = findRoute(plugin.routes, 'DELETE', '/:projectId')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'nope' },
      })
      expect(status).toBe(400)
      expect(body.error).toMatch(/not found/i)
    })

    it('deletes linked Bakin tasks when deleteLinkedTasks is true', async () => {
      writeProjectFixture('proj-linked', {
        title: 'Linked',
        tasks: [{ id: 't001', title: 'Linked Item', checked: false, taskId: 'board01' }],
      })
      const removeTask = mock(async (_taskId: string) => {})
      plugin.ctx.tasks.remove = removeTask

      const route = findRoute(plugin.routes, 'DELETE', '/:projectId')!
      await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-linked' },
        body: { deleteLinkedTasks: true },
      })
      expect(removeTask).toHaveBeenCalledWith('board01')
      expect(existsSync(join(projectsDir, 'proj-linked.md'))).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // POST /:projectId/checklist — add checklist item
  // -------------------------------------------------------------------------
  describe('POST /:projectId/checklist — add item', () => {
    it('adds an item to the checklist', async () => {
      writeProjectFixture('proj-cl', { title: 'Checklist Project' })

      const route = findRoute(plugin.routes, 'POST', '/:projectId/checklist')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-cl' },
        body: { title: 'New Item' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.taskItemId).toBeDefined()
    })

    it('returns 400 when projectId or title is missing', async () => {
      const route = findRoute(plugin.routes, 'POST', '/:projectId/checklist')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: { title: 'No Project Id' },
      })
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // PUT /:projectId/checklist/:itemId/toggle — toggle item
  // -------------------------------------------------------------------------
  describe('PUT /:projectId/checklist/:itemId/toggle', () => {
    it('toggles a checklist item', async () => {
      writeProjectFixture('proj-tog', {
        title: 'Toggle Project',
        tasks: [{ id: 't001', title: 'Item 1', checked: false }],
      })

      const route = findRoute(plugin.routes, 'PUT', '/:projectId/checklist/:itemId/toggle')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-tog', itemId: 't001' },
        body: { checked: true },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.progress).toBe(100)
    })

    it('returns 400 when ids are missing', async () => {
      const route = findRoute(plugin.routes, 'PUT', '/:projectId/checklist/:itemId/toggle')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: { checked: true },
      })
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // PUT /:projectId/checklist/:itemId — update item
  // -------------------------------------------------------------------------
  describe('PUT /:projectId/checklist/:itemId — update item', () => {
    it('updates item title and description', async () => {
      writeProjectFixture('proj-updi', {
        title: 'Update Item Project',
        tasks: [{ id: 't001', title: 'Original', checked: false }],
      })

      const route = findRoute(plugin.routes, 'PUT', '/:projectId/checklist/:itemId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-updi', itemId: 't001' },
        body: { title: 'Updated', description: 'Some detail' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    })

    it('returns 400 when ids are missing', async () => {
      const route = findRoute(plugin.routes, 'PUT', '/:projectId/checklist/:itemId')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: { title: 'No Ids' },
      })
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /:projectId/checklist/:itemId — remove item
  // -------------------------------------------------------------------------
  describe('DELETE /:projectId/checklist/:itemId — remove item', () => {
    it('removes a checklist item', async () => {
      writeProjectFixture('proj-rmi', {
        title: 'Remove Item Project',
        tasks: [
          { id: 't001', title: 'Keep', checked: false },
          { id: 't002', title: 'Remove', checked: false },
        ],
      })

      const route = findRoute(plugin.routes, 'DELETE', '/:projectId/checklist/:itemId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-rmi', itemId: 't002' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    })

    it('returns 400 when ids are missing', async () => {
      const route = findRoute(plugin.routes, 'DELETE', '/:projectId/checklist/:itemId')!
      const { status } = await callRoute(route, plugin.ctx, {})
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // POST /:projectId/checklist/:itemId/link — link to board task
  // -------------------------------------------------------------------------
  describe('POST /:projectId/checklist/:itemId/link', () => {
    it('links a checklist item to a board task', async () => {
      writeProjectFixture('proj-lnk', {
        title: 'Link Project',
        tasks: [{ id: 't001', title: 'Linkable', checked: false }],
      })

      const route = findRoute(plugin.routes, 'POST', '/:projectId/checklist/:itemId/link')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-lnk', itemId: 't001' },
        body: { taskId: 'board01' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    })

    it('returns 400 when required fields are missing', async () => {
      const route = findRoute(plugin.routes, 'POST', '/:projectId/checklist/:itemId/link')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-lnk', itemId: 't001' },
        body: {},
      })
      expect(status).toBe(400)
      expect(body.error).toMatch(/[Mm]issing/)
    })
  })

  // -------------------------------------------------------------------------
  // POST /:projectId/checklist/:itemId/promote — promote to task
  // -------------------------------------------------------------------------
  describe('POST /:projectId/checklist/:itemId/promote', () => {
    it('promotes a checklist item to a board task', async () => {
      writeProjectFixture('proj-prom', {
        title: 'Promote Project',
        tasks: [{ id: 't001', title: 'Promote Me', checked: false }],
      })

      const route = findRoute(plugin.routes, 'POST', '/:projectId/checklist/:itemId/promote')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-prom', itemId: 't001' },
        body: { assignee: 'pixel' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(typeof body.taskId).toBe('string')
      const tasks = await plugin.ctx.tasks.list({ projectId: 'proj-prom' })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        id: body.taskId,
        title: 'Promote Me',
        agent: 'pixel',
        projectId: 'proj-prom',
      })
    })

    it('returns 400 when ids are missing', async () => {
      const route = findRoute(plugin.routes, 'POST', '/:projectId/checklist/:itemId/promote')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: {},
      })
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // POST /:projectId/assets — attach asset
  // -------------------------------------------------------------------------
  describe('POST /:projectId/assets — attach asset', () => {
    it('attaches an asset to a project', async () => {
      writeProjectFixture('proj-att', { title: 'Attach Project' })

      const route = findRoute(plugin.routes, 'POST', '/:projectId/assets')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-att' },
        body: { assetId: '20260401-spec-abcdef12', label: 'Spec doc' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    })

    it('rejects unknown or legacy filename asset ids', async () => {
      writeProjectFixture('proj-att-missing', { title: 'Attach Project' })

      const route = findRoute(plugin.routes, 'POST', '/:projectId/assets')!
      const missing = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-att-missing' },
        body: { assetId: '20260401-missing-deadbeef' },
      })
      const legacy = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-att-missing' },
        body: { assetId: 'old-hero.png' },
      })

      expect(missing.status).toBe(404)
      expect(missing.body.error).toContain('Asset not found')
      expect(legacy.status).toBe(404)
      expect(legacy.body.error).toContain('Asset not found')

      const repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
      expect(repo.readProject('proj-att-missing')!.assets).toEqual([])
    })

    it('returns 400 when projectId or assetId is missing', async () => {
      const route = findRoute(plugin.routes, 'POST', '/:projectId/assets')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: { label: 'No assetId' },
      })
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /:projectId/assets/:assetId — relink asset reference
  // -------------------------------------------------------------------------
  describe('PATCH /:projectId/assets/:assetId — relink asset reference', () => {
    it('relinks an attached asset to another existing asset', async () => {
      writeProjectFixture('proj-rel', {
        title: 'Relink Project',
        assets: [{ assetId: '20260401-brief-abcdef12', label: 'Brief' }],
      })

      const route = findRoute(plugin.routes, 'PATCH', '/:projectId/assets/:assetId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-rel', assetId: '20260401-brief-abcdef12' },
        body: { newAssetId: '20260401-logo-abcdef12' },
      })

      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      const repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
      expect(repo.readProject('proj-rel')!.assets).toEqual([
        { assetId: '20260401-logo-abcdef12', label: 'Brief' },
      ])
    })

    it('returns 400 when required params are missing', async () => {
      const route = findRoute(plugin.routes, 'PATCH', '/:projectId/assets/:assetId')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: { newAssetId: '20260401-logo-abcdef12' },
      })
      expect(status).toBe(400)
    })

    it('returns 404 when the replacement asset does not exist', async () => {
      writeProjectFixture('proj-rel-missing', {
        title: 'Relink Project',
        assets: [{ assetId: '20260401-brief-abcdef12', label: 'Brief' }],
      })

      const route = findRoute(plugin.routes, 'PATCH', '/:projectId/assets/:assetId')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-rel-missing', assetId: '20260401-brief-abcdef12' },
        body: { newAssetId: '20260401-missing-deadbeef' },
      })

      expect(status).toBe(404)
      expect(body.error).toContain('Asset not found')
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /:projectId/assets/:assetId — detach asset
  // -------------------------------------------------------------------------
  describe('DELETE /:projectId/assets/:assetId — detach asset', () => {
    it('detaches an asset from a project', async () => {
      writeProjectFixture('proj-det', {
        title: 'Detach Project',
        assets: [{ assetId: '20260401-spec-abcdef12', label: 'Spec' }],
      })

      const route = findRoute(plugin.routes, 'DELETE', '/:projectId/assets/:assetId')!
      expect(route).toBeDefined()
      const { status, body } = await callRoute(route, plugin.ctx, {
        searchParams: { projectId: 'proj-det', assetId: '20260401-spec-abcdef12' },
      })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    })

    it('returns 400 when required params are missing', async () => {
      const route = findRoute(plugin.routes, 'DELETE', '/:projectId/assets/:assetId')!
      const { status } = await callRoute(route, plugin.ctx, {})
      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // POST /:projectId/ask — agent brainstorm
  // -------------------------------------------------------------------------
  describe('POST /:projectId/ask — agent brainstorm (turn engine, bakin#703)', () => {
    /** Record every projects.brainstorm.* bus event during a turn. */
    function collectBusEvents(): { events: Array<{ event: string; data: Record<string, unknown> }>; stop: () => void } {
      const events: Array<{ event: string; data: Record<string, unknown> }> = []
      const off = plugin.ctx.events.on('*', (event, data) => {
        if (event.startsWith('projects.brainstorm.')) events.push({ event, data })
      })
      return { events, stop: off }
    }

    /** Resolves when the in-flight turn settles (done or error bus event). */
    function nextSettle(): Promise<void> {
      return new Promise((resolve) => {
        const off = plugin.ctx.events.on('*', (event) => {
          if (event === 'projects.brainstorm.done' || event === 'projects.brainstorm.error') {
            off()
            resolve()
          }
        })
      })
    }

    it('202s immediately; chunks and done ride the bus; the transcript persists durable rows', async () => {
      writeProjectFixture('proj-ask', {
        title: 'Ask Project',
        tasks: [{ id: 't001', title: 'Do stuff', checked: true }],
        assets: [{ assetId: '20260401-brief-abcdef12', label: 'Brief' }],
      })
      const streamMock = mockRuntimeStream(['Hel', 'lo ', 'world'])
      const bus = collectBusEvents()
      const settled = nextSettle()

      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      const { response } = await callRoute(route, plugin.ctx, {
        body: { projectId: 'proj-ask', prompt: 'What should we do next?' },
        rawResponse: true,
      })
      expect(response.status).toBe(202)
      await settled
      bus.stop()

      const tokens = bus.events
        .filter((e) => e.event === 'projects.brainstorm.chunk' && (e.data.chunk as { type: string }).type === 'text')
        .map((e) => (e.data.chunk as { content: string }).content)
      expect(tokens).toEqual(['Hel', 'lo ', 'world'])
      for (const e of bus.events) expect(e.data.projectId).toBe('proj-ask')
      const done = bus.events.find((e) => e.event === 'projects.brainstorm.done')
      expect(done?.data).toMatchObject({ projectId: 'proj-ask', agentId: 'main', preview: 'Hello world' })

      // Context was built with project metadata; the transcript keeps the
      // clean prompt (the assembled context rides runtimeContent only).
      expect(streamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'main',
          content: expect.stringContaining('Ask Project'),
        }),
      )
      const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
      const hydrated = await callRoute(getRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-ask' },
      })
      expect(hydrated.body.project.brainstormMessages).toMatchObject([
        { kind: 'user', content: 'What should we do next?' },
        { kind: 'assistant', content: 'Hello world' },
      ])
      expect(hydrated.body.project.brainstormStreaming).toBe(false)
    })

    it('instructs brainstorm agents to treat the plan as the primary artifact: apply incremental edits, ask before big rewrites', async () => {
      writeProjectFixture('proj-plan-prompt', { title: 'Plan Prompt Project' })
      const streamMock = mockRuntimeStream(['ok'])
      const settled = nextSettle()

      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      await callRoute(route, plugin.ctx, {
        body: { projectId: 'proj-plan-prompt', prompt: 'Help me think through launch sequencing.' },
      })
      await settled

      const prompt = String(streamMock.mock.calls[0]?.[0]?.content ?? '')
      expect(prompt).toContain('PRIMARY working artifact — actively create, edit, and refine it')
      expect(prompt).toContain('Apply INCREMENTAL updates directly, then report exactly what you changed')
      expect(prompt).toContain('ASK FIRST — in chat, before applying — for wholesale rewrites or large deletions')
      expect(prompt).toContain('Prefer bakin_exec_projects_apply_plan for combined body and checklist updates')
      expect(prompt).toContain('snapshotted with a visible diff and one-click restore')
      expect(prompt).toContain('Invoke Bakin tools as described in your Tool access section — the exact call form depends on the active runtime.')
    })

    it('the bakin_exec_projects_ask tool sends the SAME plan-first instructions (single shared constant)', async () => {
      writeProjectFixture('proj-tool-prompt', { title: 'Tool Prompt Project' })
      const sendMock = mock(async (args: MessageArgs) => ({ id: 'msg-1', content: 'tool reply', ...(args ? {} : {}) }))
      plugin.ctx.runtime.messaging.send = sendMock

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_ask')!
      const result = await callTool(tool, { projectId: 'proj-tool-prompt', message: 'What next?' })
      expect(result).toMatchObject({ ok: true, reply: 'tool reply' })

      const prompt = String(sendMock.mock.calls[0]?.[0]?.content ?? '')
      expect(prompt).toContain('PRIMARY working artifact — actively create, edit, and refine it')
      expect(prompt).toContain('ASK FIRST — in chat, before applying — for wholesale rewrites or large deletions')
      expect(prompt).toContain('User request:\nWhat next?')
    })

    it('persists brainstorm turns without replaying them into durable runtime prompts', async () => {
      writeProjectFixture('proj-persist', { title: 'Persistent Project' })
      const prompts: string[] = []
      const threadIds: Array<string | undefined> = []
      const streamMock = mock((args: MessageArgs) => {
        prompts.push(args.content)
        threadIds.push(args.threadId)
        return streamTextChunks(prompts.length === 1 ? ['First answer'] : ['Second answer'])
      })
      plugin.ctx.runtime.messaging.stream = streamMock

      const askRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      let settled = nextSettle()
      await callRoute(askRoute, plugin.ctx, {
        body: { projectId: 'proj-persist', prompt: 'First question?' },
      })
      await settled

      const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
      const hydrated = await callRoute(getRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-persist' },
      })
      expect(hydrated.body.project.brainstormMessages).toMatchObject([
        { kind: 'user', content: 'First question?' },
        { kind: 'assistant', content: 'First answer' },
      ])

      settled = nextSettle()
      await callRoute(askRoute, plugin.ctx, {
        body: { projectId: 'proj-persist', prompt: 'Second question?' },
      })
      await settled

      expect(streamMock).toHaveBeenCalledTimes(2)
      expect(threadIds).toEqual(['projects:proj-persist:main', 'projects:proj-persist:main'])
      expect(prompts[1]).not.toContain('Previous conversation in this brainstorm session:')
      expect(prompts[1]).not.toContain('User: First question?')
      expect(prompts[1]).not.toContain('Assistant: First answer')
      expect(prompts[1]).toContain('User request:\nSecond question?')
    })

    it('forwards runtime status and tool chunks on the bus; result-phase tools persist as rows', async () => {
      writeProjectFixture('proj-activity', { title: 'Activity Project' })
      mockRuntimeChunks([
        { type: 'status', content: 'Reading project context', data: { step: 'context' } },
        {
          type: 'tool',
          content: 'exec: gh issue list',
          data: {
            phase: 'call',
            callId: 'call-1',
            toolName: 'exec',
            status: 'running',
            summary: 'gh issue list',
            inputPreview: '{"command":"gh issue list"}',
          },
        },
        {
          type: 'tool',
          data: {
            phase: 'result',
            callId: 'call-1',
            toolName: 'exec',
            status: 'completed',
            outputPreview: '3 open issues',
            durationMs: 420,
          },
        },
        { type: 'text', content: 'Done.' },
      ])
      const bus = collectBusEvents()
      const settled = nextSettle()

      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      await callRoute(route, plugin.ctx, {
        body: { projectId: 'proj-activity', prompt: 'Check tickets' },
      })
      await settled
      bus.stop()

      // The bus carries raw runtime chunks — the kit folds them client-side.
      const chunkTypes = bus.events
        .filter((e) => e.event === 'projects.brainstorm.chunk')
        .map((e) => (e.data.chunk as { type: string }).type)
      expect(chunkTypes).toEqual(['status', 'tool', 'tool', 'text'])
      expect(bus.events.find((e) => e.event === 'projects.brainstorm.done')?.data).toMatchObject({ preview: 'Done.' })

      // Durable rows: user + the RESULT-phase tool (call summary merged) +
      // assistant. Status chunks are ephemeral, call phases fold into results.
      const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
      const hydrated = await callRoute(getRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-activity' },
      })
      expect(hydrated.body.project.brainstormMessages).toMatchObject([
        { kind: 'user', content: 'Check tickets' },
        {
          kind: 'tool',
          toolName: 'exec',
          callId: 'call-1',
          status: 'completed',
          summary: 'gh issue list',
          inputPreview: '{"command":"gh issue list"}',
          outputPreview: '3 open issues',
          durationMs: 420,
        },
        { kind: 'assistant', content: 'Done.' },
      ])
    })

    it('uses the custom agent; the durable runtime prompt never replays history', async () => {
      writeProjectFixture('proj-ask2', { title: 'Ask 2' })
      const streamMock = mockRuntimeStream(['ok'])
      const settled = nextSettle()

      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      await callRoute(route, plugin.ctx, {
        body: {
          projectId: 'proj-ask2',
          prompt: 'Continue',
          agent: 'pixel',
        },
      })
      await settled
      expect(streamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'pixel',
          threadId: 'projects:proj-ask2:pixel',
          content: expect.stringContaining('User request:\nContinue'),
        }),
      )
      const call = streamMock.mock.calls[0]?.[0]
      expect(call?.content).not.toContain('Previous conversation')
      expect(call?.content).not.toContain('Start')
      expect(call?.content).not.toContain('OK')
    })

    it('one turn per project: concurrent send 409s; the abort route settles the turn clean', async () => {
      writeProjectFixture('proj-busy', { title: 'Busy Project' })
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      plugin.ctx.runtime.messaging.stream = mock((args: MessageArgs) => {
        void args
        return (async function* (): AsyncIterable<ChatChunk> {
          yield { type: 'text', content: 'partial' }
          await gate
          yield { type: 'done' }
        })()
      })

      const askRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      const settled = nextSettle()
      const first = await callRoute(askRoute, plugin.ctx, {
        body: { projectId: 'proj-busy', prompt: 'go' },
      })
      expect(first.status).toBe(202)
      const second = await callRoute(askRoute, plugin.ctx, {
        body: { projectId: 'proj-busy', prompt: 'again' },
      })
      expect(second.status).toBe(409)

      // Mid-turn, the GET seeds the streaming flag for remount rehydration.
      const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
      const midTurn = await callRoute(getRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-busy' },
      })
      expect(midTurn.body.project.brainstormStreaming).toBe(true)

      const abortRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask/abort')!
      const aborted = await callRoute(abortRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-busy' },
      })
      expect(aborted.status).toBe(200)
      release()
      await settled

      const hydrated = await callRoute(getRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-busy' },
      })
      const rows = hydrated.body.project.brainstormMessages as Array<{ kind: string }>
      expect(rows[rows.length - 1]?.kind).toBe('aborted')
      expect(rows.some((r) => r.kind === 'assistant')).toBe(true) // partial kept

      // Idle abort → 409.
      const idle = await callRoute(abortRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-busy' },
      })
      expect(idle.status).toBe(409)
    })

    it('meters brainstorm turns under work class chat with the brainstorm runId scheme', async () => {
      writeProjectFixture('proj-meter', { title: 'Meter Project' })
      mockRuntimeStream(['ok'])
      plugin.meteredTurns.length = 0
      const settled = nextSettle()
      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      await callRoute(route, plugin.ctx, {
        body: { projectId: 'proj-meter', prompt: 'hi' },
      })
      await settled
      expect(plugin.meteredTurns).toHaveLength(1)
      expect(String(plugin.meteredTurns[0].runId)).toStartWith('brainstorm:projects:proj-meter:turn:')
      expect(plugin.meteredTurns[0].workClass).toBe('chat')
    })

    it('returns 400 when projectId or prompt is missing', async () => {
      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      const { status } = await callRoute(route, plugin.ctx, {
        body: { projectId: 'proj-ask' },
      })
      expect(status).toBe(400)
    })

    it('returns 404 when the project does not exist', async () => {
      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      const { status, body } = await callRoute(route, plugin.ctx, {
        body: { projectId: 'nonexistent', prompt: 'Hello' },
      })
      expect(status).toBe(404)
      expect(body.error).toMatch(/not found/i)
    })

    it('attention totals: unread counts projects with unseen replies; seen clears; inflight lists running turns', async () => {
      writeProjectFixture('proj-att', { title: 'Attention Project' })
      mockRuntimeStream(['A reply'])
      const settled = nextSettle()
      const askRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      await callRoute(askRoute, plugin.ctx, {
        body: { projectId: 'proj-att', prompt: 'hi' },
      })
      await settled

      const attentionRoute = findRoute(plugin.routes, 'GET', '/brainstorm/attention')!
      let res = await callRoute(attentionRoute, plugin.ctx, {})
      expect(res.body).toMatchObject({ unreadTotal: 1, inflight: [] })

      const seenRoute = findRoute(plugin.routes, 'POST', '/:projectId/brainstorm/seen')!
      const seen = await callRoute(seenRoute, plugin.ctx, { searchParams: { projectId: 'proj-att' } })
      expect(seen.status).toBe(200)

      res = await callRoute(attentionRoute, plugin.ctx, {})
      expect(res.body).toMatchObject({ unreadTotal: 0, inflight: [] })

      // Ghost project seen → 404.
      const ghost = await callRoute(seenRoute, plugin.ctx, { searchParams: { projectId: 'ghost' } })
      expect(ghost.status).toBe(404)
    })

    it('attention inflight lists a mid-turn project (working-dot truth)', async () => {
      writeProjectFixture('proj-att2', { title: 'Attention 2' })
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      plugin.ctx.runtime.messaging.stream = mock((args: MessageArgs) => {
        void args
        return (async function* (): AsyncIterable<ChatChunk> {
          yield { type: 'text', content: 'partial' }
          await gate
          yield { type: 'done' }
        })()
      })
      const settled = nextSettle()
      const askRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      await callRoute(askRoute, plugin.ctx, { body: { projectId: 'proj-att2', prompt: 'go' } })

      const attentionRoute = findRoute(plugin.routes, 'GET', '/brainstorm/attention')!
      const midTurn = await callRoute(attentionRoute, plugin.ctx, {})
      expect(midTurn.body.inflight).toEqual(['proj-att2'])
      release()
      await settled
    })

    it('history routes: GET lists snapshots; restore round-trips through the service', async () => {
      writeProjectFixture('proj-hist', { title: 'History Project', body: 'original body' })
      const putRoute = findRoute(plugin.routes, 'PUT', '/:projectId')!
      await callRoute(putRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-hist' },
        body: { body: 'edited body' },
      })

      const historyRoute = findRoute(plugin.routes, 'GET', '/:projectId/history')!
      const history = await callRoute(historyRoute, plugin.ctx, { searchParams: { projectId: 'proj-hist' } })
      expect(history.status).toBe(200)
      expect(history.body.history).toMatchObject([{ author: 'user', body: 'original body' }])

      const restoreRoute = findRoute(plugin.routes, 'POST', '/:projectId/history/:index/restore')!
      const restored = await callRoute(restoreRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-hist', index: '0' },
      })
      expect(restored.status).toBe(200)

      const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
      const hydrated = await callRoute(getRoute, plugin.ctx, { searchParams: { projectId: 'proj-hist' } })
      expect(hydrated.body.project.body).toBe('original body')

      // Bad index → 400; ghost project → 404.
      const bad = await callRoute(restoreRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-hist', index: '99' },
      })
      expect(bad.status).toBe(400)
      const ghost = await callRoute(historyRoute, plugin.ctx, { searchParams: { projectId: 'ghost' } })
      expect(ghost.status).toBe(404)
    })

    it('a failing runtime stream settles as an error turn — durable error row + bus error event', async () => {
      writeProjectFixture('proj-fail', { title: 'Fail Project' })
      mockRuntimeStreamError('unreachable')
      const bus = collectBusEvents()
      const settled = nextSettle()

      const route = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
      const { response } = await callRoute(route, plugin.ctx, {
        body: { projectId: 'proj-fail', prompt: 'Help' },
        rawResponse: true,
      })
      expect(response.status).toBe(202)
      await settled
      bus.stop()

      const errEvent = bus.events.find((e) => e.event === 'projects.brainstorm.error')
      expect(errEvent).toBeDefined()
      expect(String(errEvent!.data.message)).toMatch(/unreachable/i)

      const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
      const hydrated = await callRoute(getRoute, plugin.ctx, {
        searchParams: { projectId: 'proj-fail' },
      })
      const rows = hydrated.body.project.brainstormMessages as Array<{ kind: string; message?: string }>
      expect(rows[rows.length - 1]).toMatchObject({ kind: 'error', message: 'unreachable' })
    })
  })
})

// ===========================================================================
// EXEC TOOLS
// ===========================================================================

describe('Exec Tools', () => {
  // -------------------------------------------------------------------------
  // bakin_exec_projects_list
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_list', () => {
    it('lists all projects', async () => {
      writeProjectFixture('proj-a', { title: 'A', status: 'active' })
      writeProjectFixture('proj-b', { title: 'B', status: 'draft' })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_list')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, {})
      expect(result.ok).toBe(true)
      const projects = result.projects as Array<Record<string, unknown>>
      expect(projects).toHaveLength(2)
    })

    it('filters by status', async () => {
      writeProjectFixture('proj-a', { title: 'A', status: 'active' })
      writeProjectFixture('proj-b', { title: 'B', status: 'draft' })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_list')!
      const result = await callTool(tool, { status: 'active' })
      const projects = result.projects as Array<Record<string, unknown>>
      expect(projects).toHaveLength(1)
      expect(projects[0].title).toBe('A')
    })

    it('returns empty list when no projects', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_list')!
      const result = await callTool(tool, {})
      expect(result.projects).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_get
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_get', () => {
    it('returns a project with resolved linked tasks', async () => {
      writeProjectFixture('proj-get', {
        title: 'Get Project',
        tasks: [{ id: 't001', title: 'Linked', checked: false, taskId: 'board01' }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_get')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-get' })
      expect(result.ok).toBe(true)
      const project = result.project as Record<string, unknown>
      expect(project.title).toBe('Get Project')
      expect(project.resolvedTasks).toBeDefined()
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_get')!
      const result = await callTool(tool, { projectId: 'ghost' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_create
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_create', () => {
    it('creates a project and returns id', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_create')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { title: 'Created via Tool' })
      expect(result.ok).toBe(true)
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
    })

    it('creates with initial tasks', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_create')!
      const result = await callTool(tool, {
        title: 'With Items',
        tasks: ['Item A', 'Item B'],
        body: '# Plan',
        owner: 'scout',
      }, 'scout')
      expect(result.ok).toBe(true)
      const items = result.taskItems as Array<Record<string, unknown>>
      expect(items).toHaveLength(2)
      expect(items[0].title).toBe('Item A')
    })

    it('uses agent as owner fallback', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_create')!
      const result = await callTool(tool, { title: 'Agent Owner' }, 'pixel')
      expect(result.ok).toBe(true)
      // The owner should be 'pixel' (passed as agent param)
      const project = createProjectRepository(new MarkdownStorageAdapter(testDir)).readProject(result.id as string)
      expect(project!.owner).toBe('pixel')
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_update
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_update', () => {
    it('updates project fields', async () => {
      writeProjectFixture('proj-tool-upd', { title: 'Old', status: 'draft' })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_update')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, {
        projectId: 'proj-tool-upd',
        title: 'New Title',
        status: 'active',
      })
      expect(result.ok).toBe(true)
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_update')!
      const result = await callTool(tool, { projectId: 'ghost', title: 'X' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })

    it('returns error when completing with unchecked items', async () => {
      writeProjectFixture('proj-incomplete', {
        title: 'Incomplete',
        tasks: [{ id: 't001', title: 'Not done', checked: false }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_update')!
      const result = await callTool(tool, { projectId: 'proj-incomplete', status: 'completed' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/unchecked/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_apply_plan
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_apply_plan', () => {
    it('updates the project body and appends checklist items in one tool call', async () => {
      writeProjectFixture('proj-apply-plan', {
        title: 'Apply Plan',
        body: '# Old Plan',
        tasks: [{ id: 't001', title: 'Existing item', checked: false }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_apply_plan')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, {
        projectId: 'proj-apply-plan',
        body: '# Release Plan\n\n## Scope\nShip the release tracker.',
        checklistItems: ['Draft release notes', 'Confirm rollout owner'],
      })

      expect(result.ok).toBe(true)
      expect(result.addedItems).toEqual([
        { id: 't002', title: 'Draft release notes' },
        { id: 't003', title: 'Confirm rollout owner' },
      ])

      const project = createProjectRepository(new MarkdownStorageAdapter(testDir)).readProject('proj-apply-plan')!
      expect(project.body).toBe('# Release Plan\n\n## Scope\nShip the release tracker.')
      expect(project.tasks.map((task) => ({ id: task.id, title: task.title, checked: task.checked }))).toEqual([
        { id: 't001', title: 'Existing item', checked: false },
        { id: 't002', title: 'Draft release notes', checked: false },
        { id: 't003', title: 'Confirm rollout owner', checked: false },
      ])
    })

    it('returns an error when both body and appendBody are provided', async () => {
      writeProjectFixture('proj-apply-invalid', { title: 'Apply Invalid' })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_apply_plan')!
      const result = await callTool(tool, {
        projectId: 'proj-apply-invalid',
        body: '# Replacement',
        appendBody: 'Appendix',
      })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/body or appendBody/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_delete
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_delete', () => {
    it('deletes a project', async () => {
      writeProjectFixture('proj-tool-del', { title: 'Delete Me' })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_delete')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-tool-del' })
      expect(result.ok).toBe(true)
      expect(existsSync(join(projectsDir, 'proj-tool-del.md'))).toBe(false)
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_delete')!
      const result = await callTool(tool, { projectId: 'nope' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_add_item
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_add_item', () => {
    it('adds a checklist item', async () => {
      writeProjectFixture('proj-ai', { title: 'Add Item', tasks: [{ id: 't001', title: 'Existing', checked: false }] })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_add_item')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-ai', title: 'New Item' })
      expect(result.ok).toBe(true)
      expect(result.taskItemId).toBe('t002')
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_mark_item
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_mark_item', () => {
    it('marks an item as checked', async () => {
      writeProjectFixture('proj-mi', {
        title: 'Mark Item',
        tasks: [{ id: 't001', title: 'To Check', checked: false }, { id: 't002', title: 'Other', checked: false }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_mark_item')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-mi', taskItemId: 't001', checked: true })
      expect(result.ok).toBe(true)
      expect(result.progress).toBe(50) // 1 of 2
    })

    it('unchecks an item', async () => {
      writeProjectFixture('proj-mi2', {
        title: 'Uncheck',
        tasks: [{ id: 't001', title: 'Checked', checked: true }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_mark_item')!
      const result = await callTool(tool, { projectId: 'proj-mi2', taskItemId: 't001', checked: false })
      expect(result.ok).toBe(true)
      expect(result.progress).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_remove_item
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_remove_item', () => {
    it('removes a checklist item', async () => {
      writeProjectFixture('proj-ri', {
        title: 'Remove Item',
        tasks: [{ id: 't001', title: 'Remove', checked: false }, { id: 't002', title: 'Keep', checked: false }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_remove_item')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-ri', taskItemId: 't001' })
      expect(result.ok).toBe(true)
    })

    it('returns error for non-existent item', async () => {
      writeProjectFixture('proj-ri2', { title: 'No Item', tasks: [] })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_remove_item')!
      const result = await callTool(tool, { projectId: 'proj-ri2', taskItemId: 't999' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_link_item
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_link_item', () => {
    it('links a board task to a checklist item', async () => {
      writeProjectFixture('proj-li', {
        title: 'Link Item',
        tasks: [{ id: 't001', title: 'To Link', checked: false }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_link_item')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-li', taskItemId: 't001', taskId: 'board01' })
      expect(result.ok).toBe(true)
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_link_item')!
      const result = await callTool(tool, { projectId: 'ghost', taskItemId: 't001', taskId: 'board01' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_promote_item
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_promote_item', () => {
    it('promotes a checklist item to a board task', async () => {
      writeProjectFixture('proj-pi', {
        title: 'Promote Item',
        tasks: [{ id: 't001', title: 'Promote Me', checked: false }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_promote_item')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-pi', taskItemId: 't001', assignee: 'pixel' })
      expect(result.ok).toBe(true)
      expect(typeof result.taskId).toBe('string')
      const tasks = await plugin.ctx.tasks.list({ projectId: 'proj-pi' })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        id: result.taskId,
        title: 'Promote Me',
        agent: 'pixel',
        projectId: 'proj-pi',
      })
    })

    it('returns error if item already linked', async () => {
      writeProjectFixture('proj-pi2', {
        title: 'Already Linked',
        tasks: [{ id: 't001', title: 'Linked', checked: false, taskId: 'existing01' }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_promote_item')!
      const result = await callTool(tool, { projectId: 'proj-pi2', taskItemId: 't001' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/already linked/i)
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_promote_item')!
      const result = await callTool(tool, { projectId: 'ghost', taskItemId: 't001' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_attach_asset
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_attach_asset', () => {
    it('attaches an asset', async () => {
      writeProjectFixture('proj-aa', { title: 'Attach Asset' })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_attach_asset')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, {
        projectId: 'proj-aa',
        assetId: '20260401-logo-abcdef12',
        label: 'Logo',
      })
      expect(result.ok).toBe(true)
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_attach_asset')!
      const result = await callTool(tool, { projectId: 'ghost', assetId: '20260401-x-abcdef12' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_relink_asset
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_relink_asset', () => {
    it('relinks an attached asset', async () => {
      writeProjectFixture('proj-ra', {
        title: 'Relink Asset',
        assets: [{ assetId: '20260401-brief-abcdef12', label: 'Brief' }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_relink_asset')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, {
        projectId: 'proj-ra',
        assetId: '20260401-brief-abcdef12',
        newAssetId: '20260401-logo-abcdef12',
      })

      expect(result.ok).toBe(true)
      const repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
      expect(repo.readProject('proj-ra')!.assets).toEqual([
        { assetId: '20260401-logo-abcdef12', label: 'Brief' },
      ])
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_relink_asset')!
      const result = await callTool(tool, {
        projectId: 'ghost',
        assetId: '20260401-brief-abcdef12',
        newAssetId: '20260401-logo-abcdef12',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // bakin_exec_projects_detach_asset
  // -------------------------------------------------------------------------
  describe('bakin_exec_projects_detach_asset', () => {
    it('detaches an asset', async () => {
      writeProjectFixture('proj-da', {
        title: 'Detach Asset',
        assets: [{ assetId: '20260401-brief-abcdef12', label: 'Brief' }],
      })

      const tool = findTool(plugin.execTools, 'bakin_exec_projects_detach_asset')!
      expect(tool).toBeDefined()
      const result = await callTool(tool, { projectId: 'proj-da', assetId: '20260401-brief-abcdef12' })
      expect(result.ok).toBe(true)
    })

    it('returns error for non-existent project', async () => {
      const tool = findTool(plugin.execTools, 'bakin_exec_projects_detach_asset')!
      const result = await callTool(tool, { projectId: 'ghost', assetId: '20260401-x-abcdef12' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })
})

// ===========================================================================
// Search route (auto-registered via ctx.search.registerFileBackedContentType)
// ===========================================================================

describe('GET /search — auto-registered search route', () => {
  it('returns 200 with seeded results on a happy-path query', async () => {
    plugin.seedResults([
      {
        id: 'p1',
        table: 'bakin_projects',
        score: 0.9,
        fields: { title: 'Project One' },
      },
    ])

    const { status, body } = await callSearchRoute(plugin, 'project')
    expect(status).toBe(200)
    const results = body.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('p1')
    expect(results[0].table).toBe('bakin_projects')
    expect(results[0].score).toBe(0.9)
    expect((results[0].fields as Record<string, unknown>).title).toBe('Project One')
  })

  it('returns 400 when q is missing', async () => {
    const route = findRoute(plugin.routes, 'GET', '/search')!
    expect(route).toBeDefined()
    const { status, body } = await callRoute(route, plugin.ctx)
    expect(status).toBe(400)
    expect(body.error).toMatch(/[Mm]issing/)
  })

  it('returns 200 with empty results for a zero-result query', async () => {
    plugin.seedResults([])

    const { status, body } = await callSearchRoute(plugin, 'no-such-thing')
    expect(status).toBe(200)
    const results = body.results as unknown[]
    expect(results).toEqual([])
    const meta = body.meta as Record<string, unknown> | undefined
    expect(meta?.total).toBe(0)
  })

  it('passes facets through to ctx.search.query', async () => {
    plugin.seedResults([])

    await callSearchRoute(plugin, 'anything', { facets: 'status' })

    expect(plugin.ctx.search.query).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'anything',
        facets: ['status'],
      }),
    )
  })
})

// ===========================================================================
// Registration completeness
// ===========================================================================

describe('Registration', () => {
  it('registers all expected routes', async () => {
    const expectedRoutes = [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/:projectId' },
      { method: 'POST', path: '/' },
      { method: 'PUT', path: '/:projectId' },
      { method: 'DELETE', path: '/:projectId' },
      { method: 'POST', path: '/:projectId/checklist' },
      { method: 'PUT', path: '/:projectId/checklist/:itemId/toggle' },
      { method: 'PUT', path: '/:projectId/checklist/:itemId' },
      { method: 'DELETE', path: '/:projectId/checklist/:itemId' },
      { method: 'POST', path: '/:projectId/checklist/:itemId/link' },
      { method: 'POST', path: '/:projectId/checklist/:itemId/promote' },
      { method: 'POST', path: '/:projectId/assets' },
      { method: 'PATCH', path: '/:projectId/assets/:assetId' },
      { method: 'DELETE', path: '/:projectId/assets/:assetId' },
      { method: 'POST', path: '/:projectId/ask' },
      { method: 'GET', path: '/search' },
    ]

    for (const { method, path } of expectedRoutes) {
      const route = findRoute(plugin.routes, method, path)
      expect(route, `Missing route: ${method} ${path}`).toBeDefined()
    }
  })

  it('registers all expected exec tools', async () => {
    const expectedTools = [
      'bakin_exec_projects_list',
      'bakin_exec_projects_get',
      'bakin_exec_projects_create',
      'bakin_exec_projects_update',
      'bakin_exec_projects_apply_plan',
      'bakin_exec_projects_delete',
      'bakin_exec_projects_add_item',
      'bakin_exec_projects_mark_item',
      'bakin_exec_projects_remove_item',
      'bakin_exec_projects_link_item',
      'bakin_exec_projects_promote_item',
      'bakin_exec_projects_attach_asset',
      'bakin_exec_projects_relink_asset',
      'bakin_exec_projects_detach_asset',
    ]

    for (const name of expectedTools) {
      const tool = findTool(plugin.execTools, name)
      expect(tool, `Missing exec tool: ${name}`).toBeDefined()
    }
  })

  it('registers hooks', () => {
    expect(plugin.ctx.hooks.register).toHaveBeenCalledWith(
      'tasks.statusChanged',
      expect.any(Function),
      expect.objectContaining({
        hookKind: 'event',
        label: 'Sync project task state.',
      }),
    )
    expect(plugin.ctx.hooks.register).toHaveBeenCalledWith(
      'tasks.enrichDetails',
      expect.any(Function),
      expect.objectContaining({
        hookKind: 'waterfall',
        label: 'Add project task context.',
      }),
    )
  })

  it('watches project files', () => {
    expect(plugin.ctx.watchFiles).toHaveBeenCalledWith(['projects/*.md'])
  })
})
