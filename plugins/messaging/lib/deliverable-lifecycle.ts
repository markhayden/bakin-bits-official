import type { PluginContext } from '@makinbakin/sdk/types'
import type { Deliverable, MessagingSettings } from '../types'
import type { MessagingContentStorage } from './content-storage'
import { contentTypeFor } from './content-type-lookup'
import { recomputePlanStatus } from './plan-status'
import { buildFilesFromDraft, publishDeliverableNow } from './publish'
import {
  approveWorkflowGateForDeliverable,
  rejectWorkflowGateForDeliverable,
  type ApprovalActor,
} from './workflow-bridge'
import type { DeliverableFailureStage } from '../types'

export type DeliverableLifecycleResult =
  | { ok: true; deliverable: Deliverable; published?: boolean }
  | { ok: false; status: number; error: string; deliverable?: Deliverable }

type DeliverableLifecycleFailure = Extract<DeliverableLifecycleResult, { ok: false }>

const DEFAULT_APPROVER: ApprovalActor = { id: 'mark', source: 'web' }
const PUBLISH_BLOCKED_STATUSES = new Set(['published', 'cancelled', 'failed'])
const REOPENABLE_FAILURE_STAGES = new Set<DeliverableFailureStage>(['validation', 'workflow_handoff', 'workflow'])

function getDeliverableOrNotFound(store: MessagingContentStorage, deliverableId: string): Deliverable | DeliverableLifecycleFailure {
  const deliverable = store.getDeliverable(deliverableId)
  return deliverable ?? { ok: false, status: 404, error: 'Deliverable not found' }
}

function isLifecycleFailure(value: Deliverable | DeliverableLifecycleFailure): value is DeliverableLifecycleFailure {
  return 'ok' in value && value.ok === false
}

function recomputeLinkedPlan(store: MessagingContentStorage, deliverable: Deliverable): void {
  if (deliverable.planId) recomputePlanStatus(store, deliverable.planId)
}

function clearFailurePatch(): Partial<Deliverable> {
  return {
    failureReason: null as never,
    failureStage: null as never,
    failedStep: null as never,
    failedAt: null as never,
  }
}

function inferFailureStage(deliverable: Deliverable): DeliverableFailureStage | null {
  if (deliverable.failureStage) return deliverable.failureStage
  const reason = deliverable.failureReason ?? ''
  if (reason.startsWith('workflow.complete fired')) return 'workflow_handoff'
  if (reason.startsWith('Channel delivery')) return 'delivery'
  if (reason.includes('asset missing') || reason.includes('not resolvable')) return 'validation'
  return null
}

function assertRecoverableFailure(
  deliverable: Deliverable,
  allowedStages: Set<DeliverableFailureStage>,
): { ok: true; stage: DeliverableFailureStage } | DeliverableLifecycleFailure {
  if (deliverable.status !== 'failed') {
    return { ok: false, status: 400, error: `Deliverable status "${deliverable.status}" cannot be recovered`, deliverable }
  }
  const stage = inferFailureStage(deliverable)
  if (!stage || !allowedStages.has(stage)) {
    return {
      ok: false,
      status: 409,
      error: stage ? `Failure stage "${stage}" cannot use this recovery action` : 'Deliverable failure does not have a recoverable stage',
      deliverable,
    }
  }
  return { ok: true, stage }
}

async function validateAssets(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  deliverable: Deliverable,
): Promise<{ ok: true } | DeliverableLifecycleFailure> {
  const contentType = contentTypeFor(settings, deliverable.contentType)
  const result = await buildFilesFromDraft(deliverable, contentType, ctx)
  if (result.ok) return { ok: true }
  return {
    ok: false,
    status: 400,
    error: result.reason,
    deliverable: store.getDeliverable(deliverable.id) ?? deliverable,
  }
}

async function requeueTaskForChanges(ctx: PluginContext, deliverable: Deliverable, note: string, approver: ApprovalActor): Promise<void> {
  if (!deliverable.taskId) return
  try {
    await ctx.tasks.update(deliverable.taskId, { column: 'inProgress' })
    await ctx.tasks.appendLog(deliverable.taskId, {
      timestamp: new Date().toISOString(),
      author: approver.id,
      message: `Changes requested: ${note || 'No note provided.'}`,
      data: { deliverableId: deliverable.id, source: approver.source },
    })
  } catch {
    // Task requeue is best-effort; Deliverable status remains the source of truth.
  }
}

async function requeueBareTaskForRecovery(
  ctx: PluginContext,
  deliverable: Deliverable,
  reason: string,
  approver: ApprovalActor,
): Promise<string | undefined> {
  if (deliverable.taskId) {
    try {
      const task = await ctx.tasks.get(deliverable.taskId)
      if (task && !['done', 'archived'].includes(task.column)) {
        await ctx.tasks.update(deliverable.taskId, { column: 'inProgress' })
        await ctx.tasks.appendLog(deliverable.taskId, {
          timestamp: new Date().toISOString(),
          author: approver.id,
          message: `Recovery requested: ${reason}`,
          data: { deliverableId: deliverable.id, source: approver.source },
        })
        return deliverable.taskId
      }
    } catch {
      // Missing or unmodifiable linked tasks fall through to a new repair task.
    }
  }

  const task = await ctx.tasks.create({
    title: `Repair content prep: ${deliverable.title}`,
    description: [
      deliverable.brief,
      '',
      `Recovery reason: ${reason}`,
    ].join('\n'),
    column: 'inProgress',
    agent: deliverable.agent,
    createdBy: 'messaging',
    source: {
      pluginId: 'messaging',
      entityType: 'deliverable',
      entityId: deliverable.id,
      purpose: 'repair',
    },
  })
  await ctx.tasks.appendLog(task.id, {
    timestamp: new Date().toISOString(),
    author: approver.id,
    message: `Recovery requested: ${reason}`,
    data: { deliverableId: deliverable.id, source: approver.source },
  })
  return task.id
}

function gateUnavailable(deliverable: Deliverable): DeliverableLifecycleFailure | null {
  if (!deliverable.workflowInstanceId) return null
  if (!deliverable.taskId || !deliverable.pendingGateStepId) {
    return {
      ok: false,
      status: 409,
      error: 'Workflow-backed Deliverable is not waiting on a workflow gate',
      deliverable,
    }
  }
  return null
}

export async function markDeliverableReadyForReview(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  deliverableId: string,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable
  if (deliverable.workflowInstanceId) {
    return {
      ok: false,
      status: 409,
      error: 'Workflow-backed Deliverables enter review through workflow gates',
      deliverable,
    }
  }
  if (deliverable.status !== 'in_prep' && deliverable.status !== 'changes_requested') {
    return { ok: false, status: 400, error: `Deliverable status "${deliverable.status}" cannot be marked ready for review`, deliverable }
  }

  const assets = await validateAssets(store, ctx, settings, deliverable)
  if (!assets.ok) return assets

  const contentType = contentTypeFor(settings, deliverable.contentType)
  const nextStatus = contentType.requiresApproval === false ? 'approved' : 'in_review'
  const updated = store.updateDeliverable(deliverable.id, { status: nextStatus })
  recomputeLinkedPlan(store, updated)
  ctx.activity.audit('deliverable.ready_for_review', deliverable.agent, {
    deliverableId: deliverable.id,
    status: nextStatus,
  })
  ctx.activity.log(deliverable.agent, `Marked "${deliverable.title}" ${nextStatus === 'approved' ? 'approved' : 'ready for review'}`)
  return { ok: true, deliverable: updated }
}

export async function approveDeliverable(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  deliverableId: string,
  approver: ApprovalActor = DEFAULT_APPROVER,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable

  if (deliverable.workflowInstanceId) {
    if (!ctx.hooks.has('workflows.approveGate')) {
      return { ok: false, status: 409, error: 'Workflow gate approval is unavailable', deliverable }
    }
    const unavailable = gateUnavailable(deliverable)
    if (unavailable) return unavailable
    const assets = await validateAssets(store, ctx, settings, deliverable)
    if (!assets.ok) return assets
    const result = await approveWorkflowGateForDeliverable(store, ctx, deliverable.id, approver)
    return result.ok ? { ok: true, deliverable: result.deliverable } : result
  }

  if (deliverable.status !== 'in_review') {
    return { ok: false, status: 400, error: `Deliverable status "${deliverable.status}" cannot be approved`, deliverable }
  }
  const assets = await validateAssets(store, ctx, settings, deliverable)
  if (!assets.ok) return assets

  const updated = store.updateDeliverable(deliverable.id, { status: 'approved' })
  recomputeLinkedPlan(store, updated)
  ctx.activity.audit('deliverable.approved', approver.id, { deliverableId: updated.id })
  ctx.activity.log(updated.agent, `Approved "${updated.title}"`)
  return { ok: true, deliverable: updated }
}

export async function rejectDeliverable(
  store: MessagingContentStorage,
  ctx: PluginContext,
  deliverableId: string,
  note: string,
  approver: ApprovalActor = DEFAULT_APPROVER,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable

  if (deliverable.workflowInstanceId) {
    if (!ctx.hooks.has('workflows.rejectGate')) {
      return { ok: false, status: 409, error: 'Workflow gate rejection is unavailable', deliverable }
    }
    const unavailable = gateUnavailable(deliverable)
    if (unavailable) return unavailable
    const result = await rejectWorkflowGateForDeliverable(store, ctx, deliverable.id, note, approver)
    return result.ok ? { ok: true, deliverable: result.deliverable } : result
  }

  if (deliverable.status !== 'in_review') {
    return { ok: false, status: 400, error: `Deliverable status "${deliverable.status}" cannot be rejected`, deliverable }
  }
  const updated = store.updateDeliverable(deliverable.id, {
    status: 'changes_requested',
    rejectionNote: note,
  })
  recomputeLinkedPlan(store, updated)
  await requeueTaskForChanges(ctx, updated, note, approver)
  ctx.activity.audit('deliverable.rejected', approver.id, { deliverableId: updated.id, note })
  ctx.activity.log(updated.agent, `Changes requested for "${updated.title}"`)
  return { ok: true, deliverable: updated }
}

export async function approveAndPublishDeliverableNow(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  deliverableId: string,
  approver: ApprovalActor = DEFAULT_APPROVER,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable
  if (deliverable.workflowInstanceId) {
    return {
      ok: false,
      status: 409,
      error: 'Workflow-backed Deliverables must be approved through the workflow gate',
      deliverable,
    }
  }
  if (PUBLISH_BLOCKED_STATUSES.has(deliverable.status)) {
    return { ok: false, status: 400, error: `Deliverable status "${deliverable.status}" cannot be published now`, deliverable }
  }

  const approved = store.updateDeliverable(deliverable.id, { status: 'approved' })
  recomputeLinkedPlan(store, approved)
  ctx.activity.audit('deliverable.approved', approver.id, { deliverableId: approved.id, publishNow: true })
  const contentType = contentTypeFor(settings, approved.contentType)
  const result = await publishDeliverableNow(store, approved, contentType, ctx)
  recomputeLinkedPlan(store, result.deliverable)
  if (result.ok) return { ok: true, deliverable: result.deliverable, published: true }
  const status = result.reason.startsWith('Channel delivery') ? 502 : 400
  return { ok: false, status, error: result.reason, deliverable: result.deliverable }
}

export async function restoreDeliverableApproval(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  deliverableId: string,
  approver: ApprovalActor = DEFAULT_APPROVER,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable

  const recoverable = assertRecoverableFailure(deliverable, new Set<DeliverableFailureStage>(['workflow_handoff']))
  if (!recoverable.ok) return recoverable
  if (!deliverable.workflowInstanceId || !deliverable.taskId) {
    return { ok: false, status: 409, error: 'Only workflow-backed Deliverables can restore approval', deliverable }
  }
  if (!ctx.hooks.has('workflows.loadInstance')) {
    return { ok: false, status: 409, error: 'Workflow instance loading is unavailable. Reopen prep instead.', deliverable }
  }

  const instance = await ctx.hooks.invoke<Record<string, unknown>>('workflows.loadInstance', { taskId: deliverable.taskId })
  if (!instance) return { ok: false, status: 409, error: 'Workflow instance could not be loaded. Reopen prep instead.', deliverable }
  if (typeof instance.instanceId === 'string' && instance.instanceId !== deliverable.workflowInstanceId) {
    return { ok: false, status: 409, error: 'Workflow instance does not match Deliverable. Reopen prep instead.', deliverable }
  }
  if (instance.status !== 'complete') {
    return { ok: false, status: 409, error: 'Workflow is not complete. Reopen prep instead.', deliverable }
  }

  const assets = await validateAssets(store, ctx, settings, deliverable)
  if (!assets.ok) return assets

  const updated = store.updateDeliverable(deliverable.id, {
    status: 'approved',
    ...clearFailurePatch(),
  })
  recomputeLinkedPlan(store, updated)
  ctx.activity.audit('deliverable.failure_recovered', approver.id, {
    deliverableId: updated.id,
    action: 'restore_approval',
    source: approver.source,
  })
  ctx.activity.log(updated.agent, `Restored approval for "${updated.title}"`, { category: 'messaging' })
  return { ok: true, deliverable: updated }
}

export async function reopenDeliverablePrep(
  store: MessagingContentStorage,
  ctx: PluginContext,
  deliverableId: string,
  approver: ApprovalActor = DEFAULT_APPROVER,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable

  const recoverable = assertRecoverableFailure(deliverable, REOPENABLE_FAILURE_STAGES)
  if (!recoverable.ok) return recoverable
  const reason = deliverable.failureReason ?? 'Messaging recovery requested'
  let taskId = deliverable.taskId

  if (deliverable.workflowInstanceId) {
    if (!deliverable.taskId) return { ok: false, status: 409, error: 'Workflow-backed Deliverable is missing its task link', deliverable }
    if (!ctx.hooks.has('workflows.reopenFromStep')) {
      return { ok: false, status: 409, error: 'Workflow recovery is unavailable', deliverable }
    }
    const reopened = await ctx.hooks.invoke<Record<string, unknown>>('workflows.reopenFromStep', {
      taskId: deliverable.taskId,
      instanceId: deliverable.workflowInstanceId,
      stepId: deliverable.failedStep ?? deliverable.pendingGateStepId,
      reason,
      actor: approver,
      metadata: { deliverableId: deliverable.id, planId: deliverable.planId },
    })
    if (!reopened || reopened.success !== true) {
      const errors = Array.isArray(reopened?.errors) ? reopened.errors.join('; ') : 'Workflow recovery failed'
      return { ok: false, status: 409, error: errors, deliverable }
    }
  } else {
    taskId = await requeueBareTaskForRecovery(ctx, deliverable, reason, approver)
  }

  const updated = store.updateDeliverable(deliverable.id, {
    status: 'changes_requested',
    taskId,
    pendingGateStepId: null as never,
    rejectionNote: reason,
    ...clearFailurePatch(),
  })
  recomputeLinkedPlan(store, updated)
  ctx.activity.audit('deliverable.failure_recovered', approver.id, {
    deliverableId: updated.id,
    action: 'reopen_prep',
    source: approver.source,
    taskId,
  })
  ctx.activity.log(updated.agent, `Reopened prep for "${updated.title}": ${reason}`, { category: 'messaging' })
  return { ok: true, deliverable: updated }
}

export async function retryDeliverableDelivery(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  deliverableId: string,
  approver: ApprovalActor = DEFAULT_APPROVER,
): Promise<DeliverableLifecycleResult> {
  const deliverable = getDeliverableOrNotFound(store, deliverableId)
  if (isLifecycleFailure(deliverable)) return deliverable

  const recoverable = assertRecoverableFailure(deliverable, new Set<DeliverableFailureStage>(['delivery']))
  if (!recoverable.ok) return recoverable

  const contentType = contentTypeFor(settings, deliverable.contentType)
  const result = await publishDeliverableNow(store, deliverable, contentType, ctx)
  recomputeLinkedPlan(store, result.deliverable)
  ctx.activity.audit('deliverable.failure_recovered', approver.id, {
    deliverableId: result.deliverable.id,
    action: 'retry_delivery',
    source: approver.source,
    success: result.ok,
  })
  if (result.ok) return { ok: true, deliverable: result.deliverable, published: true }
  const status = result.reason.startsWith('Channel delivery') ? 502 : 400
  return { ok: false, status, error: result.reason, deliverable: result.deliverable }
}
