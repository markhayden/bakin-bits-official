import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MessagingSettings } from '../types'
import { MarkdownStorageAdapter, createTestContext } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'
import {
  approveWorkflowGateForDeliverable,
  handleWorkflowComplete,
  registerMessagingWorkflowBridge,
  rejectWorkflowGateForDeliverable,
} from '../lib/workflow-bridge'

const settings: MessagingSettings = {
  contentTypes: [{
    id: 'blog',
    label: 'Blog post',
    assetRequirement: 'optional-image',
    workflowId: 'messaging-blog-prep',
  }],
}

function withStore(test: (
  store: ReturnType<typeof createMessagingContentStorage>,
  ctx: ReturnType<typeof createTestContext>['ctx'],
) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-workflow-bridge-'))
  const storage = new MarkdownStorageAdapter(dir)
  const { ctx } = createTestContext('messaging', dir, { storage })
  const store = createMessagingContentStorage(storage)
  ctx.hooks.has = mock((name: string) => [
    'workflows.approveGate',
    'workflows.rejectGate',
  ].includes(name)) as typeof ctx.hooks.has
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

function seedWorkflowDeliverable(
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
    status: 'in_prep',
    taskId: 'task-1',
    workflowInstanceId: 'workflow-instance-1',
    ...overrides,
  })
  return { plan, deliverable }
}

async function flushEvents(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('messaging workflow bridge', () => {
  it('moves workflow-backed Deliverables into review when a gate is reached', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store)
    registerMessagingWorkflowBridge(store, ctx, () => settings, { warn: mock(), error: mock() })

    ctx.events.emit('workflow.gate_reached', { taskId: 'task-1', stepId: 'review-copy' })
    await flushEvents()

    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('in_review')
    expect(saved.pendingGateStepId).toBe('review-copy')
    expect(store.getPlan('plan-1')?.status).toBe('in_review')
  }))

  it('publishes approved workflow-backed Deliverables when the workflow completes', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, {
      status: 'approved',
      draft: { caption: 'Ready from workflow.' },
    })
    registerMessagingWorkflowBridge(store, ctx, () => settings, { warn: mock(), error: mock() })

    ctx.events.emit('workflow.complete', { taskId: 'task-1' })
    await flushEvents()

    expect(ctx.runtime.channels.deliverContent).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      content: expect.objectContaining({ body: 'Ready from workflow.' }),
    }))
    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('published')
    expect(saved.publishedDeliveryRef).toBe('content-general')
    expect(store.getPlan('plan-1')?.status).toBe('done')
  }))

  it('uses publish validation on workflow completion', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, {
      status: 'approved',
      contentType: 'image',
    })

    await handleWorkflowComplete(store, ctx, {
      contentTypes: [{ id: 'image', label: 'Image post', assetRequirement: 'image' }],
    }, { taskId: 'task-1' })

    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('failed')
    expect(saved.failureReason).toBe('Required image asset missing on Deliverable')
    expect(store.getPlan('plan-1')?.status).toBe('failed')
  }))

  it('marks workflow completion before approval as failed', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, { status: 'in_review' })

    await handleWorkflowComplete(store, ctx, settings, { taskId: 'task-1' })

    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('failed')
    expect(saved.failureReason).toBe('workflow.complete fired but messaging-side status was in_review')
    expect(ctx.runtime.channels.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      message: expect.objectContaining({ title: 'Workflow publish failed: Taco blog' }),
    }))
  }))

  it('approves workflow gates after setting messaging-side status', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, {
      status: 'in_review',
      pendingGateStepId: 'review-copy',
    })
    ctx.hooks.invoke = mock(async () => ({ ok: true })) as typeof ctx.hooks.invoke

    const result = await approveWorkflowGateForDeliverable(store, ctx, 'deliverable-1', { id: 'mark', source: 'web' })

    expect(result.ok).toBe(true)
    expect(ctx.hooks.invoke).toHaveBeenCalledWith('workflows.approveGate', {
      taskId: 'task-1',
      stepId: 'review-copy',
      approver: { id: 'mark', source: 'web' },
    })
    expect(store.getDeliverable('deliverable-1')?.status).toBe('approved')
    expect(store.getPlan('plan-1')?.status).toBe('scheduled')
  }))

  it('rolls approval status back when approveGate fails', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, {
      status: 'in_review',
      pendingGateStepId: 'review-copy',
    })
    ctx.hooks.invoke = mock(async () => { throw new Error('gate unavailable') }) as typeof ctx.hooks.invoke

    const result = await approveWorkflowGateForDeliverable(store, ctx, 'deliverable-1', { id: 'mark', source: 'web' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.status).toBe(502)
    expect(store.getDeliverable('deliverable-1')?.status).toBe('in_review')
    expect(store.getPlan('plan-1')?.status).toBe('in_review')
  }))

  it('rejects workflow gates through rejectGate', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, {
      status: 'in_review',
      pendingGateStepId: 'review-copy',
    })
    ctx.hooks.invoke = mock(async () => ({ ok: true })) as typeof ctx.hooks.invoke

    const result = await rejectWorkflowGateForDeliverable(store, ctx, 'deliverable-1', 'Tighten the opening.', { id: 'mark', source: 'web' })

    expect(result.ok).toBe(true)
    expect(ctx.hooks.invoke).toHaveBeenCalledWith('workflows.rejectGate', {
      taskId: 'task-1',
      stepId: 'review-copy',
      reason: 'Tighten the opening.',
      approver: { id: 'mark', source: 'web' },
    })
    const saved = store.getDeliverable('deliverable-1')!
    expect(saved.status).toBe('changes_requested')
    expect(saved.rejectionNote).toBe('Tighten the opening.')
    expect(store.getPlan('plan-1')?.status).toBe('in_prep')
  }))

  it('restores prior status when rejectGate fails', async () => withStore(async (store, ctx) => {
    seedWorkflowDeliverable(store, {
      status: 'in_review',
      pendingGateStepId: 'review-copy',
    })
    ctx.hooks.invoke = mock(async () => { throw new Error('gate unavailable') }) as typeof ctx.hooks.invoke

    const result = await rejectWorkflowGateForDeliverable(store, ctx, 'deliverable-1', 'Try again.', { id: 'mark', source: 'web' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.status).toBe(502)
    expect(store.getDeliverable('deliverable-1')?.status).toBe('in_review')
    expect(store.getPlan('plan-1')?.status).toBe('in_review')
  }))

  it('disables event subscriptions when workflow gate hooks are absent', () => withStore((store, ctx) => {
    ctx.hooks.has = mock(() => false) as typeof ctx.hooks.has
    const logger = { warn: mock(), error: mock() }

    registerMessagingWorkflowBridge(store, ctx, () => settings, logger)

    seedWorkflowDeliverable(store)
    ctx.events.emit('workflow.gate_reached', { taskId: 'task-1', stepId: 'review-copy' })
    expect(store.getDeliverable('deliverable-1')?.status).toBe('in_prep')
    expect(logger.warn).toHaveBeenCalled()
  }))
})
