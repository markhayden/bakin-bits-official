import { describe, expect, it, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = join(tmpdir(), `bakin-test-messaging-plans-${Date.now()}`)
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

describe('Plan routes', () => {
  it('creates, lists, gets, updates, and deletes a Plan', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Taco Tuesday',
        brief: 'A taco topic.',
        targetDate: '2026-05-19',
        agent: 'basil',
        campaign: 'spring',
        suggestedChannels: ['blog'],
      },
    })

    expect(created.status).toBe(200)
    const plan = created.body.plan as Record<string, unknown>
    expect(plan.status).toBe('planning')

    const listRoute = findRoute(plugin.routes, 'GET', '/plans')!
    const listed = await callRoute(listRoute, plugin.ctx, { searchParams: { agent: 'basil' } })
    expect((listed.body.plans as unknown[]).length).toBe(1)

    const getRoute = findRoute(plugin.routes, 'GET', '/plans/:id')!
    const got = await callRoute(getRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect((got.body.plan as Record<string, unknown>).title).toBe('Taco Tuesday')
    expect(got.body.deliverables).toEqual([])

    const updateRoute = findRoute(plugin.routes, 'PUT', '/plans/:id')!
    const updated = await callRoute(updateRoute, plugin.ctx, {
      searchParams: { id: plan.id as string },
      body: { title: 'Updated tacos', status: 'fanning_out' },
    })
    expect((updated.body.plan as Record<string, unknown>).title).toBe('Updated tacos')
    expect((updated.body.plan as Record<string, unknown>).status).toBe('fanning_out')

    const deleteRoute = findRoute(plugin.routes, 'DELETE', '/plans/:id')!
    const deleted = await callRoute(deleteRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect(deleted.body.ok).toBe(true)
    expect(plugin.ctx.storage.exists(`messaging/plans/${plan.id}.json`)).toBe(false)
  })

  it('starts fan-out by creating one bare Bakin task for the Plan', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Fan-out tacos',
        brief: 'Turn the taco plan into channel-specific work.',
        targetDate: '2026-05-21',
        agent: 'basil',
        campaign: 'spring',
        suggestedChannels: ['blog', 'general'],
      },
    })
    const plan = created.body.plan as Record<string, unknown>

    const startRoute = findRoute(plugin.routes, 'POST', '/plans/:id/start-fanout')!
    const started = await callRoute(startRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    expect(started.status).toBe(200)
    expect(started.body.ok).toBe(true)
    expect(started.body.alreadyStarted).toBe(false)
    expect((started.body.plan as Record<string, unknown>).status).toBe('planning')
    expect((started.body.plan as Record<string, unknown>).fanOutTaskId).toBe(started.body.taskId)
    expect(plugin.ctx.tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      parentId: null,
      agent: 'basil',
      column: 'todo',
      title: 'Plan: Fan-out tacos',
    }))

    const task = await plugin.ctx.tasks.get(started.body.taskId as string)
    expect(task?.description).toContain('Plan ID:')
    expect(task?.description).toContain('Suggested channels: blog, general')
    expect(task?.description).toContain('bakin_exec_messaging_propose_deliverable')

    const repeated = await callRoute(startRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect(repeated.body.alreadyStarted).toBe(true)
    expect(plugin.ctx.tasks.create).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when required create fields are missing', async () => {
    const route = findRoute(plugin.routes, 'POST', '/plans')!
    const { status, body } = await callRoute(route, plugin.ctx, { body: { title: 'Missing fields' } })
    expect(status).toBe(400)
    expect(body.error).toBe('title, targetDate, and agent required')
  })
})

describe('Plan exec tools', () => {
  it('creates and reads Plans', async () => {
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_plan_create')!
    const created = await callTool(create, {
      title: 'Soup Wednesday',
      brief: 'A soup topic.',
      targetDate: '2026-05-20',
      agent: 'basil',
    })
    expect(created.ok).toBe(true)

    const list = findTool(plugin.execTools, 'bakin_exec_messaging_plan_list')!
    const listed = await callTool(list, { agent: 'basil' })
    expect(listed.count).toBe(1)

    const get = findTool(plugin.execTools, 'bakin_exec_messaging_plan_get')!
    const got = await callTool(get, { planId: ((created.plan as Record<string, unknown>).id as string) })
    expect(got.ok).toBe(true)
    expect((got.plan as Record<string, unknown>).title).toBe('Soup Wednesday')

    const startFanout = findTool(plugin.execTools, 'bakin_exec_messaging_plan_start_fanout')!
    const started = await callTool(startFanout, { planId: ((created.plan as Record<string, unknown>).id as string) })
    expect(started.ok).toBe(true)
    expect(started.taskId).toBe((started.plan as Record<string, unknown>).fanOutTaskId)
  })
})
