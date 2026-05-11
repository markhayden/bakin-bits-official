import type { PluginContext } from '@bakin/sdk/types'
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

export type DeliverableLifecycleResult =
  | { ok: true; deliverable: Deliverable; published?: boolean }
  | { ok: false; status: number; error: string; deliverable?: Deliverable }

type DeliverableLifecycleFailure = Extract<DeliverableLifecycleResult, { ok: false }>

const DEFAULT_APPROVER: ApprovalActor = { id: 'mark', source: 'web' }
const PUBLISH_BLOCKED_STATUSES = new Set(['published', 'cancelled', 'failed'])

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

async function requeueTaskForChanges(ctx: PluginContext, deliverable: Deliverable, note: string): Promise<void> {
  if (!deliverable.taskId) return
  try {
    await ctx.tasks.update(deliverable.taskId, { column: 'inProgress' })
    await ctx.tasks.appendLog(deliverable.taskId, {
      timestamp: new Date().toISOString(),
      author: 'mark',
      message: `Changes requested: ${note || 'No note provided.'}`,
      data: { deliverableId: deliverable.id },
    })
  } catch {
    // Task requeue is best-effort; Deliverable status remains the source of truth.
  }
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
  await requeueTaskForChanges(ctx, updated, note)
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
