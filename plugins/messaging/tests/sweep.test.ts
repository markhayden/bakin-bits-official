import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MessagingSettings } from '../types'
import { MarkdownStorageAdapter, createTestContext } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'
import { runMessagingContentSweep } from '../lib/sweep'

function withStore(test: (
  store: ReturnType<typeof createMessagingContentStorage>,
  ctx: ReturnType<typeof createTestContext>['ctx'],
) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-sweep-'))
  const storage = new MarkdownStorageAdapter(dir)
  const { ctx } = createTestContext('messaging', dir, { storage })
  const store = createMessagingContentStorage(storage)
  const finish = () => rmSync(dir, { recursive: true, force: true })
  try {
    const result = test(store, ctx)
    if (result instanceof Promise) return result.finally(finish)
    finish()
  } catch (err) {
    finish()
    throw err
  }
}

function seedPlanAndDeliverable(
  store: ReturnType<typeof createMessagingContentStorage>,
  overrides: Record<string, unknown> = {},
) {
  const plan = store.createPlan({
    id: 'plan-1',
    title: 'Taco Tuesday',
    brief: 'A taco plan.',
    targetDate: '2026-05-25',
    agent: 'basil',
  })
  const deliverable = store.createDeliverable({
    id: 'deliverable-1',
    planId: plan.id,
    channel: 'general',
    contentType: 'blog',
    tone: 'conversational',
    agent: 'basil',
    title: 'Taco blog',
    brief: 'Write the taco blog.',
    publishAt: '2026-05-25T16:00:00Z',
    prepStartAt: '2026-05-25T12:00:00Z',
    status: 'planned',
    ...overrides,
  })
  return { plan, deliverable }
}

const settings: MessagingSettings = {
  contentTypes: [
    {
      id: 'blog',
      label: 'Blog post',
      prepLeadHours: 72,
      assetRequirement: 'optional-image',
      requiresApproval: true,
    },
  ],
}

describe('runMessagingContentSweep', () => {
  it('does not start prep before prepStartAt', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store)

    const result = await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T11:59:00Z'))

    expect(result.startedPrep).toBe(0)
    expect(ctx.tasks.create).not.toHaveBeenCalled()
    expect(store.getDeliverable('deliverable-1')?.status).toBe('planned')
  }))

  it('moves due planned Deliverables into prep and creates a Bakin task', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store)

    const result = await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T12:00:00Z'))

    expect(result).toEqual({ ok: true, processed: 1, startedPrep: 1, published: 0, failed: 0, markedOverdue: 0 })
    expect(ctx.tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Prep: Taco Tuesday - general',
      agent: 'basil',
      column: 'todo',
      workflowId: undefined,
    }))
    const taskInput = ctx.tasks.create.mock.calls[0]![0]
    expect(taskInput.description).toContain('Deliverable: deliverable-1')
    expect(taskInput.description).toContain('Channel: general')
    expect(taskInput.description).toContain('bakin_exec_messaging_deliverable_update')
    expect(taskInput.description).toContain('bakin_exec_assets_save')

    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('in_prep')
    expect(saved.taskId).toBeTruthy()
    expect(store.getPlan('plan-1')?.status).toBe('in_prep')
  }))

  it('uses prepStartAtOverride when present', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store, {
      prepStartAt: '2026-05-25T12:00:00Z',
      prepStartAtOverride: '2026-05-24T12:00:00Z',
    })

    await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-24T12:00:00Z'))

    expect(ctx.tasks.create).toHaveBeenCalledTimes(1)
    expect(store.getDeliverable('deliverable-1')?.status).toBe('in_prep')
  }))

  it('passes workflowId through task creation and records the workflow instance id', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store)
    ctx.hooks.has = mock((name: string) => name === 'workflows.loadInstance') as typeof ctx.hooks.has
    ctx.hooks.invoke = mock(async () => ({ instanceId: 'workflow-instance-1' })) as typeof ctx.hooks.invoke

    await runMessagingContentSweep(store, ctx, {
      contentTypes: [{
        id: 'blog',
        label: 'Blog post',
        workflowId: 'messaging-blog-prep',
        assetRequirement: 'optional-image',
      }],
    }, new Date('2026-05-25T12:00:00Z'))

    expect(ctx.tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'messaging-blog-prep',
    }))
    expect(ctx.hooks.invoke).toHaveBeenCalledWith('workflows.loadInstance', expect.objectContaining({
      taskId: expect.any(String),
    }))
    expect(store.getDeliverable('deliverable-1')?.workflowInstanceId).toBe('workflow-instance-1')
  }))

  it('is idempotent after prep has started', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store)

    await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T12:00:00Z'))
    await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T12:00:00Z'))

    expect(ctx.tasks.create).toHaveBeenCalledTimes(1)
    expect(store.getDeliverable('deliverable-1')?.status).toBe('in_prep')
  }))

  it('publishes due approved bare Deliverables', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store, {
      status: 'approved',
      draft: { caption: 'Ready to publish.' },
      publishAt: '2026-05-25T16:00:00Z',
    })

    const result = await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T16:00:00Z'))

    expect(result.published).toBe(1)
    expect(ctx.runtime.channels.deliverContent).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      content: expect.objectContaining({ body: 'Ready to publish.' }),
    }))
    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('published')
    expect(saved.publishedDeliveryRef).toBe('content-general')
    expect(store.getPlan('plan-1')?.status).toBe('done')
  }))

  it('leaves workflow-backed approved Deliverables for workflow.complete', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store, {
      status: 'approved',
      workflowInstanceId: 'workflow-instance-1',
      publishAt: '2026-05-25T16:00:00Z',
    })

    const result = await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T16:00:00Z'))

    expect(result.processed).toBe(0)
    expect(ctx.runtime.channels.deliverContent).not.toHaveBeenCalled()
    expect(store.getDeliverable('deliverable-1')?.status).toBe('approved')
  }))

  it('marks due unapproved Deliverables overdue and notifies the owner channel', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store, {
      status: 'in_prep',
      publishAt: '2026-05-25T16:00:00Z',
    })

    const result = await runMessagingContentSweep(store, ctx, settings, new Date('2026-05-25T16:00:00Z'))

    expect(result.markedOverdue).toBe(1)
    expect(store.getDeliverable('deliverable-1')?.status).toBe('overdue')
    expect(store.getPlan('plan-1')?.status).toBe('overdue')
    expect(ctx.runtime.channels.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      message: expect.objectContaining({
        title: 'Deliverable overdue: Taco blog',
      }),
    }))
  }))

  it('marks approved Deliverables failed when publish validation fails', async () => withStore(async (store, ctx) => {
    seedPlanAndDeliverable(store, {
      status: 'approved',
      contentType: 'image',
      publishAt: '2026-05-25T16:00:00Z',
    })

    const result = await runMessagingContentSweep(store, ctx, {
      contentTypes: [{
        id: 'image',
        label: 'Image post',
        assetRequirement: 'image',
      }],
    }, new Date('2026-05-25T16:00:00Z'))

    expect(result.failed).toBe(1)
    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('failed')
    expect(saved.failureReason).toBe('Required image asset missing on Deliverable')
    expect(store.getPlan('plan-1')?.status).toBe('failed')
  }))
})
