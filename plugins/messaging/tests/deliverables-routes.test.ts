import { describe, expect, it, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = join(tmpdir(), `bakin-test-messaging-deliverables-${Date.now()}`)
process.env.BAKIN_HOME = testDir
process.env.OPENCLAW_HOME = `${testDir}-openclaw`

mock.module('../../../src/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({ messaging: testDir }),
}))
mock.module('../../../src/core/logger', () => ({
  createLogger: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }),
}))
mock.module('../../../src/core/audit', () => ({ appendAudit: mock() }))

const messagingPlugin = require('../../../plugins/messaging/index').default as typeof import('../../../plugins/messaging/index').default
import {
  activatePlugin,
  callRoute,
  callTool,
  findRoute,
  findTool,
} from '../test-helpers'
import type { ActivatedPlugin } from '../test-helpers'

let plugin: ActivatedPlugin

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true })
  plugin = await activatePlugin(messagingPlugin, testDir)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const dir of ['plans', 'deliverables']) {
    const full = join(testDir, 'messaging', dir)
    if (existsSync(full)) rmSync(full, { recursive: true, force: true })
  }
  mock.clearAllMocks()
})

async function createPlan(title = 'Taco Tuesday'): Promise<Record<string, unknown>> {
  const route = findRoute(plugin.routes, 'POST', '/plans')!
  const created = await callRoute(route, plugin.ctx, {
    body: {
      title,
      brief: 'A taco topic.',
      targetDate: '2026-05-25',
      agent: 'basil',
    },
  })
  return created.body.plan as Record<string, unknown>
}

describe('Deliverable routes', () => {
  it('creates, lists, gets, updates, and deletes a planned Deliverable under a Plan', async () => {
    const plan = await createPlan()
    const createRoute = findRoute(plugin.routes, 'POST', '/deliverables')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        planId: plan.id,
        channel: 'general',
        contentType: 'blog',
        tone: 'conversational',
        agent: 'basil',
        title: 'Taco blog',
        brief: 'Write the taco blog.',
        publishAt: '2026-05-25T16:00:00Z',
      },
    })

    expect(created.status).toBe(200)
    const deliverable = created.body.deliverable as Record<string, unknown>
    expect(deliverable.status).toBe('planned')
    expect(deliverable.prepStartAt).toBe('2026-05-22T16:00:00.000Z')

    const listRoute = findRoute(plugin.routes, 'GET', '/deliverables')!
    const listed = await callRoute(listRoute, plugin.ctx, {
      searchParams: {
        planId: plan.id as string,
        status: 'planned',
        channel: 'general',
        publishAfter: '2026-05-25T00:00:00Z',
        publishBefore: '2026-05-26T00:00:00Z',
      },
    })
    expect((listed.body.deliverables as unknown[]).length).toBe(1)

    const getRoute = findRoute(plugin.routes, 'GET', '/deliverables/:id')!
    const got = await callRoute(getRoute, plugin.ctx, { searchParams: { id: deliverable.id as string } })
    expect((got.body.deliverable as Record<string, unknown>).title).toBe('Taco blog')

    const updateRoute = findRoute(plugin.routes, 'PUT', '/deliverables/:id')!
    await callRoute(updateRoute, plugin.ctx, {
      searchParams: { id: deliverable.id as string },
      body: { draft: { caption: 'First caption' } },
    })
    const updated = await callRoute(updateRoute, plugin.ctx, {
      searchParams: { id: deliverable.id as string },
      body: { title: 'Updated taco blog', draft: { imageFilename: 'taco.png' } },
    })
    expect((updated.body.deliverable as Record<string, unknown>).title).toBe('Updated taco blog')
    expect((updated.body.deliverable as Record<string, unknown>).draft).toEqual({
      caption: 'First caption',
      imageFilename: 'taco.png',
    })

    const planRoute = findRoute(plugin.routes, 'GET', '/plans/:id')!
    const recomputedPlan = await callRoute(planRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect((recomputedPlan.body.plan as Record<string, unknown>).status).toBe('in_prep')

    const deleteRoute = findRoute(plugin.routes, 'DELETE', '/deliverables/:id')!
    const deleted = await callRoute(deleteRoute, plugin.ctx, { searchParams: { id: deliverable.id as string } })
    expect(deleted.body.ok).toBe(true)
    expect(plugin.ctx.storage.exists(`messaging/deliverables/${deliverable.id}.json`)).toBe(false)
  })

  it('creates Quick Posts with nullable planId and lists them via planId=null', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/deliverables')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        planId: null,
        channel: 'announcements',
        contentType: 'announcement',
        tone: 'energetic',
        agent: 'basil',
        title: 'Quick update',
        brief: 'Ship an update now.',
        publishAt: '2026-05-25T16:00:00Z',
      },
    })

    const deliverable = created.body.deliverable as Record<string, unknown>
    expect(deliverable.planId).toBeNull()
    expect(deliverable.prepStartAt).toBe('2026-05-25T15:00:00.000Z')

    const listRoute = findRoute(plugin.routes, 'GET', '/deliverables')!
    const listed = await callRoute(listRoute, plugin.ctx, { searchParams: { planId: 'null' } })
    expect((listed.body.deliverables as unknown[]).length).toBe(1)
  })

  it('returns 404 when creating under a missing Plan', async () => {
    const route = findRoute(plugin.routes, 'POST', '/deliverables')!
    const { status, body } = await callRoute(route, plugin.ctx, {
      body: {
        planId: 'missing-plan',
        channel: 'general',
        contentType: 'blog',
        tone: 'conversational',
        agent: 'basil',
        title: 'Missing plan',
        brief: 'Should fail.',
        publishAt: '2026-05-25T16:00:00Z',
      },
    })
    expect(status).toBe(404)
    expect(body.error).toBe('Plan not found')
  })
})

describe('Deliverable exec tools', () => {
  it('creates, lists, gets, and deep-merges updates for Quick Posts', async () => {
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_create')!
    const created = await callTool(create, {
      planId: null,
      channel: 'general',
      contentType: 'x-post',
      tone: 'conversational',
      agent: 'basil',
      title: 'Quick x-post',
      brief: 'Write a short post.',
      publishAt: '2026-05-25T16:00:00Z',
      draft: { caption: 'first' },
    })
    expect(created.ok).toBe(true)

    const list = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_list')!
    const listed = await callTool(list, { planId: null })
    expect(listed.count).toBe(1)

    const get = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_get')!
    const deliverableId = (created.deliverable as Record<string, unknown>).id as string
    const got = await callTool(get, { deliverableId })
    expect(got.ok).toBe(true)

    const update = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_update')!
    const updated = await callTool(update, {
      deliverableId,
      draft: { imageFilename: 'quick.png' },
    })
    expect((updated.deliverable as Record<string, unknown>).draft).toEqual({
      caption: 'first',
      imageFilename: 'quick.png',
    })
  })
})
