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
import { createMessagingContentStorage } from '../lib/content-storage'
import { DEFAULT_CONTENT_TYPES } from '../types'

let plugin: ActivatedPlugin

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true })
  plugin = await activatePlugin(messagingPlugin, testDir)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const dir of ['sessions', 'plans', 'deliverables']) {
    const full = join(testDir, 'messaging', dir)
    if (existsSync(full)) rmSync(full, { recursive: true, force: true })
  }
  plugin.ctx.getSettings = (() => ({})) as typeof plugin.ctx.getSettings
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
        channels: [{
          id: 'blog',
          channel: 'blog',
          contentType: 'blog',
          publishAt: '2026-05-19T16:00:00Z',
        }],
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
      body: { title: 'Updated tacos', status: 'needs_review' },
    })
    expect((updated.body.plan as Record<string, unknown>).title).toBe('Updated tacos')
    expect((updated.body.plan as Record<string, unknown>).status).toBe('needs_review')

    const deleteRoute = findRoute(plugin.routes, 'DELETE', '/plans/:id')!
    const deleted = await callRoute(deleteRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect(deleted.body.ok).toBe(true)
    expect(plugin.ctx.storage.exists(`messaging/plans/${plan.id}.json`)).toBe(false)
  })

  it('activates a Plan by creating channel Deliverables and scheduled kickoff tasks', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Content plan tacos',
        brief: 'Turn the taco plan into channel-specific work.',
        targetDate: '2026-05-21',
        agent: 'basil',
        campaign: 'spring',
        channels: [
          {
            id: 'blog',
            channel: 'blog',
            contentType: 'blog',
            publishAt: '2026-05-21T16:00:00Z',
            prepStartAt: '2026-05-20T16:00:00Z',
          },
          {
            id: 'general',
            channel: 'general',
            contentType: 'announcement',
            publishAt: '2026-05-21T18:00:00Z',
          },
        ],
      },
    })
    const plan = created.body.plan as Record<string, unknown>

    const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
    const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    expect(activated.status).toBe(200)
    expect(activated.body.ok).toBe(true)
    expect(activated.body.alreadyActivated).toBe(false)
    expect((activated.body.plan as Record<string, unknown>).status).toBe('in_prep')
    expect((activated.body.deliverables as unknown[]).length).toBe(2)
    expect((activated.body.taskIds as unknown[]).length).toBe(2)
    expect(plugin.ctx.tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      parentId: null,
      agent: 'basil',
      column: 'todo',
      title: 'Prep: Content plan tacos - blog',
      workflowId: 'messaging-blog-prep',
      availableAt: '2026-05-20T16:00:00.000Z',
      dueAt: '2026-05-21T16:00:00.000Z',
      source: {
        pluginId: 'messaging',
        entityType: 'deliverable',
        entityId: expect.any(String),
        purpose: 'kickoff',
      },
    }))
    expect(plugin.ctx.tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Prep: Content plan tacos - general',
      workflowId: undefined,
      skipWorkflowReason: expect.stringContaining('announcement'),
    }))

    const task = await plugin.ctx.tasks.get((activated.body.taskIds as string[])[0])
    expect(task?.description).toContain('Plan ID:')
    expect(task?.description).toContain('Deliverable:')
    expect(task?.description).toContain('Channel: blog')

    const repeated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect(repeated.body.alreadyActivated).toBe(true)
    expect(plugin.ctx.tasks.create).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid activation channels before creating partial work', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Invalid channel plan',
        brief: 'This should fail preflight.',
        targetDate: '2026-05-21',
        agent: 'basil',
        channels: [
          {
            id: 'blog',
            channel: 'blog',
            contentType: 'blog',
            publishAt: '2026-05-21T16:00:00Z',
          },
          {
            id: 'bad-date',
            channel: 'general',
            contentType: 'announcement',
            publishAt: 'not-a-date',
          },
        ],
      },
    })
    const plan = created.body.plan as Record<string, unknown>

    const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
    const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    expect(activated.status).toBe(400)
    expect(activated.body.error).toContain('Invalid channel "bad-date"')
    expect(plugin.ctx.tasks.create).not.toHaveBeenCalled()

    const getRoute = findRoute(plugin.routes, 'GET', '/plans/:id')!
    const got = await callRoute(getRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    expect(got.body.deliverables).toEqual([])
  })

  it('rejects unknown channel content types before creating work', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Unknown content type plan',
        brief: 'This should fail activation.',
        targetDate: '2026-05-21',
        agent: 'basil',
        channels: [{
          id: 'unknown',
          channel: 'general',
          contentType: 'not-configured',
          publishAt: '2026-05-21T16:00:00Z',
        }],
      },
    })
    const plan = created.body.plan as Record<string, unknown>

    const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
    const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    expect(activated.status).toBe(400)
    expect(activated.body.error).toContain('unknown contentType "not-configured"')
    expect(plugin.ctx.tasks.create).not.toHaveBeenCalled()
  })

  it('rolls back Deliverables when task creation fails during activation', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Rollback plan',
        brief: 'This should not leave orphaned deliverables.',
        targetDate: '2026-05-21',
        agent: 'basil',
        channels: [{
          id: 'blog',
          channel: 'blog',
          contentType: 'blog',
          publishAt: '2026-05-21T16:00:00Z',
        }],
      },
    })
    const plan = created.body.plan as Record<string, unknown>
    const originalCreate = plugin.ctx.tasks.create
    plugin.ctx.tasks.create = mock(async () => {
      throw new Error('task backend down')
    }) as typeof plugin.ctx.tasks.create

    try {
      const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
      const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

      expect(activated.status).toBe(500)
      expect(activated.body.error).toContain('task backend down')
      expect(plugin.ctx.tasks.remove).toHaveBeenCalledWith(expect.stringMatching(/^messaging-/))

      const getRoute = findRoute(plugin.routes, 'GET', '/plans/:id')!
      const got = await callRoute(getRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
      expect(got.body.deliverables).toEqual([])
    } finally {
      plugin.ctx.tasks.create = originalCreate
    }
  })

  it('cancels invalid unlinked Plan Deliverables before activation creates task-backed work', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Cleanup leaked work',
        brief: 'A plan with invalid pre-activation content.',
        targetDate: '2026-05-22',
        agent: 'basil',
        channels: [{
          id: 'x',
          channel: 'x',
          contentType: 'x-post',
          publishAt: '2026-05-22T16:00:00Z',
        }],
      },
    })
    const plan = created.body.plan as Record<string, unknown>
    const store = createMessagingContentStorage(plugin.ctx.storage)
    const leaked = store.createDeliverable({
      planId: plan.id as string,
      channel: 'x',
      contentType: 'x-post',
      tone: 'conversational',
      agent: 'basil',
      title: 'Leaked suggestion',
      brief: 'Created before the activation gate.',
      publishAt: '2026-05-22T16:00:00Z',
      prepStartAt: '2026-05-22T12:00:00Z',
      status: 'proposed',
    })

    const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
    const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    expect(activated.status).toBe(200)
    expect((activated.body.deliverables as unknown[]).length).toBe(1)
    expect((activated.body.taskIds as unknown[]).length).toBe(1)
    expect(store.getDeliverable(leaked.id)?.status).toBe('cancelled')
    expect(plugin.ctx.activity.audit).toHaveBeenCalledWith('plan.unlinked_deliverables.cancelled', 'basil', {
      planId: plan.id,
      deliverableIds: [leaked.id],
    })
  })

  it('deletes linked kickoff tasks when deleting a Plan', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Delete me',
        brief: 'This plan should be removed.',
        targetDate: '2026-05-22',
        agent: 'basil',
        channels: [{
          id: 'blog',
          channel: 'blog',
          contentType: 'blog',
          publishAt: '2026-05-22T16:00:00Z',
        }],
      },
    })
    const plan = created.body.plan as Record<string, unknown>
    const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
    const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })
    const taskIds = activated.body.taskIds as string[]

    const deleteRoute = findRoute(plugin.routes, 'DELETE', '/plans/:id')!
    const deleted = await callRoute(deleteRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    expect(deleted.body.ok).toBe(true)
    expect(deleted.body.taskIds).toEqual(taskIds)
    expect(plugin.ctx.tasks.remove).toHaveBeenCalledWith(taskIds[0])
    expect(await plugin.ctx.tasks.get(taskIds[0])).toBeNull()
    expect(plugin.ctx.storage.exists(`messaging/plans/${plan.id}.json`)).toBe(false)
  })

  it('locks bulk channel edits after activation and deletes channels through the explicit route', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/plans')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: {
        title: 'Channel delete plan',
        brief: 'This plan has two channels.',
        targetDate: '2026-05-23',
        agent: 'basil',
        channels: [
          {
            id: 'blog',
            channel: 'blog',
            contentType: 'blog',
            publishAt: '2026-05-23T16:00:00Z',
          },
          {
            id: 'general',
            channel: 'general',
            contentType: 'announcement',
            publishAt: '2026-05-23T18:00:00Z',
          },
        ],
      },
    })
    const plan = created.body.plan as Record<string, unknown>
    const activateRoute = findRoute(plugin.routes, 'POST', '/plans/:id/activate')!
    const activated = await callRoute(activateRoute, plugin.ctx, { searchParams: { id: plan.id as string } })

    const updateRoute = findRoute(plugin.routes, 'PUT', '/plans/:id')!
    const blocked = await callRoute(updateRoute, plugin.ctx, {
      searchParams: { id: plan.id as string },
      body: { channels: [] },
    })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe('Plan channels are locked after activation; delete individual channels instead')

    const deleteChannelRoute = findRoute(plugin.routes, 'DELETE', '/plans/:id/channels/:channelId')!
    const deleted = await callRoute(deleteChannelRoute, plugin.ctx, {
      searchParams: { id: plan.id as string, channelId: 'blog' },
    })

    expect(deleted.body.ok).toBe(true)
    expect((deleted.body.deliverableIds as unknown[]).length).toBe(1)
    expect((deleted.body.taskIds as unknown[]).length).toBe(1)
    expect((deleted.body.plan as Record<string, { channel: string }[]>).channels.map(channel => channel.channel)).toEqual(['general'])
    expect(plugin.ctx.tasks.remove).toHaveBeenCalledWith((deleted.body.taskIds as string[])[0])
    expect((activated.body.taskIds as string[])).toContain((deleted.body.taskIds as string[])[0])
  })

  it('deletes brainstorm sessions from the route', async () => {
    const createRoute = findRoute(plugin.routes, 'POST', '/sessions')!
    const created = await callRoute(createRoute, plugin.ctx, {
      body: { agentId: 'basil', title: 'Delete brainstorm' },
    })
    const session = created.body.session as Record<string, unknown>

    const deleteRoute = findRoute(plugin.routes, 'DELETE', '/sessions/:id')!
    const deleted = await callRoute(deleteRoute, plugin.ctx, { searchParams: { id: session.id as string } })

    expect(deleted.body).toEqual({ ok: true, planIds: [], taskIds: [] })
    expect(plugin.ctx.storage.exists(`messaging/sessions/${session.id}.json`)).toBe(false)
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
    plugin.ctx.getSettings = (() => ({ agentPlanActivationPolicy: 'allowed' })) as typeof plugin.ctx.getSettings
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_plan_create')!
    const created = await callTool(create, {
      title: 'Soup Wednesday',
      brief: 'A soup topic.',
      targetDate: '2026-05-20',
      agent: 'basil',
      channels: [{
        id: 'blog',
        channel: 'blog',
        contentType: 'blog',
        publishAt: '2026-05-20T16:00:00Z',
      }],
    })
    expect(created.ok).toBe(true)

    const list = findTool(plugin.execTools, 'bakin_exec_messaging_plan_list')!
    const listed = await callTool(list, { agent: 'basil' })
    expect(listed.count).toBe(1)

    const get = findTool(plugin.execTools, 'bakin_exec_messaging_plan_get')!
    const got = await callTool(get, { planId: ((created.plan as Record<string, unknown>).id as string) })
    expect(got.ok).toBe(true)
    expect((got.plan as Record<string, unknown>).title).toBe('Soup Wednesday')

    const activate = findTool(plugin.execTools, 'bakin_exec_messaging_plan_activate')!
    const activated = await callTool(activate, { planId: ((created.plan as Record<string, unknown>).id as string) })
    expect(activated.ok).toBe(true)
    expect((activated.taskIds as unknown[]).length).toBe(1)

    const remove = findTool(plugin.execTools, 'bakin_exec_messaging_plan_delete')!
    const deleted = await callTool(remove, { planId: ((created.plan as Record<string, unknown>).id as string) })
    expect(deleted.ok).toBe(true)
    expect(deleted.taskIds).toEqual(activated.taskIds)
  })

  it('blocks agent Plan activation by default', async () => {
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_plan_create')!
    const created = await callTool(create, {
      title: 'Approval gate plan',
      brief: 'This should not activate without human approval.',
      targetDate: '2026-05-20',
      agent: 'basil',
      channels: [{
        id: 'blog',
        channel: 'blog',
        contentType: 'blog',
        publishAt: '2026-05-20T16:00:00Z',
      }],
    }, 'main')
    expect(created.ok).toBe(true)

    const activate = findTool(plugin.execTools, 'bakin_exec_messaging_plan_activate')!
    const blocked = await callTool(activate, { planId: ((created.plan as Record<string, unknown>).id as string) }, 'main')

    expect(blocked).toEqual({
      ok: false,
      status: 403,
      error: 'Plan activation requires human approval',
    })
    expect(plugin.ctx.tasks.create).not.toHaveBeenCalled()
  })

  it('allows agent Plan activation only when explicitly enabled', async () => {
    plugin.ctx.getSettings = (() => ({
      agentPlanActivationPolicy: 'allowed',
      contentTypes: DEFAULT_CONTENT_TYPES,
    })) as typeof plugin.ctx.getSettings
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_plan_create')!
    const created = await callTool(create, {
      title: 'Explicit agent activation',
      brief: 'This is allowed by settings.',
      targetDate: '2026-05-20',
      agent: 'basil',
      channels: [{
        id: 'blog',
        channel: 'blog',
        contentType: 'blog',
        publishAt: '2026-05-20T16:00:00Z',
      }],
    }, 'main')

    const activate = findTool(plugin.execTools, 'bakin_exec_messaging_plan_activate')!
    const activated = await callTool(activate, { planId: ((created.plan as Record<string, unknown>).id as string) }, 'main')

    expect(activated.ok).toBe(true)
    expect(plugin.ctx.tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'messaging-blog-prep',
    }))
  })

  it('does not expose a direct Plan Deliverable proposal tool', () => {
    expect(findTool(plugin.execTools, 'bakin_exec_messaging_propose_deliverable')).toBeUndefined()
  })
})
