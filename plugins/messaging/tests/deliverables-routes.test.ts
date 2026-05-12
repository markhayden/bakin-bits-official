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
import { createMessagingContentStorage } from '../lib/content-storage'

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

async function createDeliverable(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const route = findRoute(plugin.routes, 'POST', '/deliverables')!
  const created = await callRoute(route, plugin.ctx, {
    body: {
      planId: null,
      channel: 'general',
      contentType: 'blog',
      tone: 'conversational',
      agent: 'basil',
      title: 'Taco blog',
      brief: 'Write the taco blog.',
      publishAt: '2026-05-25T16:00:00Z',
      ...overrides,
    },
  })
  expect(created.status).toBe(200)
  return created.body.deliverable as Record<string, unknown>
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

  it('deletes linked board tasks when deleting a Deliverable', async () => {
    const deliverable = await createDeliverable()
    const contentStore = createMessagingContentStorage(plugin.ctx.storage)
    contentStore.updateDeliverable(deliverable.id as string, { taskId: 'task-1' })

    const deleteRoute = findRoute(plugin.routes, 'DELETE', '/deliverables/:id')!
    const deleted = await callRoute(deleteRoute, plugin.ctx, {
      searchParams: { id: deliverable.id as string, deleteLinkedTasks: 'true' },
    })

    expect(deleted.body.ok).toBe(true)
    expect(deleted.body.taskIds).toEqual(['task-1'])
    expect(plugin.ctx.tasks.remove).toHaveBeenCalledWith('task-1')
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

  it('approves reviewed Deliverables only after required assets validate', async () => {
    const deliverable = await createDeliverable({
      contentType: 'image',
      status: 'in_review',
    })
    const approveRoute = findRoute(plugin.routes, 'POST', '/deliverables/:id/approve')!

    const missingAsset = await callRoute(approveRoute, plugin.ctx, { searchParams: { id: deliverable.id as string } })

    expect(missingAsset.status).toBe(400)
    expect(missingAsset.body.error).toBe('Required image asset missing on Deliverable')

    const updateRoute = findRoute(plugin.routes, 'PUT', '/deliverables/:id')!
    await callRoute(updateRoute, plugin.ctx, {
      searchParams: { id: deliverable.id as string },
      body: { draft: { imageFilename: 'hero.png' } },
    })
    const approved = await callRoute(approveRoute, plugin.ctx, { searchParams: { id: deliverable.id as string } })

    expect(approved.status).toBe(200)
    expect((approved.body.deliverable as Record<string, unknown>).status).toBe('approved')
  })

  it('approves and immediately publishes bare-task Deliverables', async () => {
    const deliverable = await createDeliverable({
      status: 'overdue',
      draft: { caption: 'Publish this now.' },
    })
    const route = findRoute(plugin.routes, 'POST', '/deliverables/:id/approve-and-publish-now')!

    const result = await callRoute(route, plugin.ctx, { searchParams: { id: deliverable.id as string } })

    expect(result.status).toBe(200)
    expect(result.body.published).toBe(true)
    expect(plugin.ctx.runtime.channels.deliverContent).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      content: expect.objectContaining({ body: 'Publish this now.' }),
    }))
    expect((result.body.deliverable as Record<string, unknown>).status).toBe('published')
  })

  it('returns 409 for approve-and-publish-now on workflow-backed Deliverables', async () => {
    const store = createMessagingContentStorage(plugin.ctx.storage)
    const deliverable = store.createDeliverable({
      id: 'workflow-deliverable',
      planId: null,
      channel: 'general',
      contentType: 'blog',
      tone: 'conversational',
      agent: 'basil',
      title: 'Workflow blog',
      brief: 'Write it.',
      publishAt: '2026-05-25T16:00:00Z',
      prepStartAt: '2026-05-25T12:00:00Z',
      status: 'approved',
      taskId: 'task-1',
      workflowInstanceId: 'workflow-instance-1',
      pendingGateStepId: 'review',
    })
    const route = findRoute(plugin.routes, 'POST', '/deliverables/:id/approve-and-publish-now')!

    const result = await callRoute(route, plugin.ctx, { searchParams: { id: deliverable.id } })

    expect(result.status).toBe(409)
    expect(result.body.error).toBe('Workflow-backed Deliverables must be approved through the workflow gate')
    expect(plugin.ctx.runtime.channels.deliverContent).not.toHaveBeenCalled()
  })

  it('marks approve-and-publish-now failures on the Deliverable', async () => {
    const deliverable = await createDeliverable({
      status: 'overdue',
      draft: { caption: 'Publish this now.' },
    })
    const originalDeliverContent = plugin.ctx.runtime.channels.deliverContent
    plugin.ctx.runtime.channels.deliverContent = mock(async () => { throw new Error('channel offline') }) as typeof plugin.ctx.runtime.channels.deliverContent
    const route = findRoute(plugin.routes, 'POST', '/deliverables/:id/approve-and-publish-now')!
    try {
      const result = await callRoute(route, plugin.ctx, { searchParams: { id: deliverable.id as string } })

      expect(result.status).toBe(502)
      expect(result.body.error).toBe('Channel delivery failed: channel offline')
      expect((result.body.deliverable as Record<string, unknown>).status).toBe('failed')
      expect((result.body.deliverable as Record<string, unknown>).failureReason).toBe('Channel delivery failed: channel offline')
    } finally {
      plugin.ctx.runtime.channels.deliverContent = originalDeliverContent
    }
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

  it('moves bare-task Deliverables through ready, reject, and approve tools', async () => {
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_create')!
    const created = await callTool(create, {
      planId: null,
      channel: 'general',
      contentType: 'image',
      tone: 'conversational',
      agent: 'basil',
      title: 'Image post',
      brief: 'Needs an image.',
      publishAt: '2026-05-25T16:00:00Z',
      status: 'in_prep',
    })
    const deliverableId = (created.deliverable as Record<string, unknown>).id as string
    const ready = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_ready_for_review')!

    const missingAsset = await callTool(ready, { deliverableId })
    expect(missingAsset.ok).toBe(false)
    expect(missingAsset.error).toBe('Required image asset missing on Deliverable')

    const update = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_update')!
    await callTool(update, { deliverableId, draft: { imageFilename: 'image.png' } })

    const readyResult = await callTool(ready, { deliverableId })
    expect((readyResult.deliverable as Record<string, unknown>).status).toBe('in_review')

    const reject = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_reject')!
    const rejected = await callTool(reject, { deliverableId, note: 'Try a stronger opener.' })
    expect((rejected.deliverable as Record<string, unknown>).status).toBe('changes_requested')

    const readyAgain = await callTool(ready, { deliverableId })
    expect((readyAgain.deliverable as Record<string, unknown>).status).toBe('in_review')

    const approve = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_approve')!
    const approved = await callTool(approve, { deliverableId })
    expect((approved.deliverable as Record<string, unknown>).status).toBe('approved')
  })

  it('auto-approves ready Deliverables when approval is not required', async () => {
    const create = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_create')!
    const created = await callTool(create, {
      planId: null,
      channel: 'general',
      contentType: 'announcement',
      tone: 'conversational',
      agent: 'basil',
      title: 'Announcement',
      brief: 'No review needed.',
      publishAt: '2026-05-25T16:00:00Z',
      status: 'in_prep',
    })
    const ready = findTool(plugin.execTools, 'bakin_exec_messaging_deliverable_ready_for_review')!

    const result = await callTool(ready, { deliverableId: (created.deliverable as Record<string, unknown>).id })

    expect((result.deliverable as Record<string, unknown>).status).toBe('approved')
  })
})
