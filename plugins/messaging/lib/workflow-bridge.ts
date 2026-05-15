import type { PluginContext } from '@bakin/sdk/types'
import type { Deliverable, MessagingSettings } from '../types'
import type { MessagingContentStorage } from './content-storage'
import { contentTypeFor } from './content-type-lookup'
import { recomputePlanStatus } from './plan-status'
import { publishDeliverableNow } from './publish'
import { isDeliverableTerminal } from './status-machine'

export interface ApprovalActor {
  id: string
  displayName?: string
  source: string
}

export type WorkflowGateResolutionResult =
  | { ok: true; deliverable: Deliverable }
  | { ok: false; error: string; status: number; deliverable?: Deliverable }

type WorkflowGateResolutionFailure = Extract<WorkflowGateResolutionResult, { ok: false }>

interface WorkflowBridgeLogger {
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function approvalActorFromEvent(data: Record<string, unknown>): ApprovalActor {
  const value = data.approver
  if (value && typeof value === 'object') {
    const approver = value as Record<string, unknown>
    const id = typeof approver.id === 'string' && approver.id.length > 0 ? approver.id : null
    if (id) {
      return {
        id,
        source: typeof approver.source === 'string' && approver.source.length > 0 ? approver.source : 'workflow',
        displayName: typeof approver.displayName === 'string' && approver.displayName.length > 0 ? approver.displayName : undefined,
      }
    }
  }
  return { id: 'workflow', source: 'workflow' }
}

function findDeliverableByTaskId(store: MessagingContentStorage, taskId: string): Deliverable | null {
  return store.listDeliverables().find(deliverable => deliverable.taskId === taskId) ?? null
}

function recomputeDeliverablePlan(store: MessagingContentStorage, deliverable: Deliverable): void {
  if (deliverable.planId) recomputePlanStatus(store, deliverable.planId)
}

async function notifyWorkflowFailure(ctx: PluginContext, deliverable: Deliverable, reason: string): Promise<void> {
  try {
    await ctx.runtime.channels.sendMessage({
      channels: [deliverable.channel],
      message: {
        title: `Workflow publish failed: ${deliverable.title}`,
        body: reason,
        metadata: { deliverableId: deliverable.id, planId: deliverable.planId },
      },
    })
  } catch {
    // Workflow failure notification is best-effort; persisted status is authoritative.
  }
}

function workflowGateUnavailable(): WorkflowGateResolutionFailure {
  return {
    ok: false,
    status: 409,
    error: 'Workflow gate resolution is unavailable because the workflows gate hooks are not registered',
  }
}

function workflowGateFields(deliverable: Deliverable): { taskId: string; stepId: string } | WorkflowGateResolutionFailure {
  if (!deliverable.workflowInstanceId || !deliverable.taskId || !deliverable.pendingGateStepId) {
    return {
      ok: false,
      status: 409,
      error: 'Deliverable is not waiting on a workflow gate',
      deliverable,
    }
  }
  return { taskId: deliverable.taskId, stepId: deliverable.pendingGateStepId }
}

export async function handleWorkflowGateReached(
  store: MessagingContentStorage,
  ctx: PluginContext,
  data: Record<string, unknown>,
): Promise<Deliverable | null> {
  const taskId = stringField(data, 'taskId')
  const stepId = stringField(data, 'stepId')
  if (!taskId || !stepId) return null

  const deliverable = findDeliverableByTaskId(store, taskId)
  if (!deliverable) return null

  const updated = store.updateDeliverable(deliverable.id, {
    status: 'in_review',
    pendingGateStepId: stepId,
  })
  recomputeDeliverablePlan(store, updated)
  ctx.activity.audit('deliverable.workflow_gate_reached', 'system', {
    deliverableId: updated.id,
    taskId,
    stepId,
  })
  ctx.activity.log(updated.agent, `Workflow gate reached for "${updated.title}"`, { taskId, category: 'messaging' })
  return updated
}

export async function handleWorkflowGateApproved(
  store: MessagingContentStorage,
  ctx: PluginContext,
  data: Record<string, unknown>,
): Promise<Deliverable | null> {
  const taskId = stringField(data, 'taskId')
  const stepId = stringField(data, 'stepId')
  if (!taskId || !stepId) return null

  const deliverable = findDeliverableByTaskId(store, taskId)
  if (!deliverable?.workflowInstanceId) return null
  if (deliverable.pendingGateStepId && deliverable.pendingGateStepId !== stepId) return null
  if (deliverable.status === 'approved' || deliverable.status === 'published') return deliverable
  if (isDeliverableTerminal(deliverable.status)) return deliverable

  const approver = approvalActorFromEvent(data)
  const updated = store.updateDeliverable(deliverable.id, { status: 'approved' })
  recomputeDeliverablePlan(store, updated)
  ctx.activity.audit('deliverable.workflow_gate_approved', approver.id, {
    deliverableId: updated.id,
    taskId,
    stepId,
    source: approver.source,
  })
  ctx.activity.log(updated.agent, `Workflow gate approved for "${updated.title}"`, { taskId, category: 'messaging' })
  return updated
}

export async function handleWorkflowGateRejected(
  store: MessagingContentStorage,
  ctx: PluginContext,
  data: Record<string, unknown>,
): Promise<Deliverable | null> {
  const taskId = stringField(data, 'taskId')
  const stepId = stringField(data, 'stepId')
  if (!taskId || !stepId) return null

  const deliverable = findDeliverableByTaskId(store, taskId)
  if (!deliverable?.workflowInstanceId) return null
  if (deliverable.pendingGateStepId && deliverable.pendingGateStepId !== stepId) return null
  if (isDeliverableTerminal(deliverable.status)) return deliverable

  const approver = approvalActorFromEvent(data)
  const reason = stringField(data, 'reason') ?? ''
  const updated = store.updateDeliverable(deliverable.id, {
    status: 'changes_requested',
    rejectionNote: reason || deliverable.rejectionNote,
  })
  recomputeDeliverablePlan(store, updated)
  ctx.activity.audit('deliverable.workflow_gate_rejected', approver.id, {
    deliverableId: updated.id,
    taskId,
    stepId,
    reason,
    source: approver.source,
  })
  ctx.activity.log(updated.agent, `Workflow gate rejected for "${updated.title}"${reason ? `: ${reason}` : ''}`, { taskId, category: 'messaging' })
  return updated
}

export async function handleWorkflowComplete(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  data: Record<string, unknown>,
): Promise<Deliverable | null> {
  const taskId = stringField(data, 'taskId')
  if (!taskId) return null

  const deliverable = findDeliverableByTaskId(store, taskId)
  if (!deliverable || !deliverable.workflowInstanceId) return null

  if (deliverable.status === 'approved') {
    const contentType = contentTypeFor(settings, deliverable.contentType)
    const result = await publishDeliverableNow(store, deliverable, contentType, ctx)
    recomputeDeliverablePlan(store, result.deliverable)
    return result.deliverable
  }

  if (deliverable.status !== 'published') {
    const reason = `workflow.complete fired but messaging-side status was ${deliverable.status}`
    const failed = store.updateDeliverable(deliverable.id, {
      status: 'failed',
      failureReason: reason,
      failureStage: 'workflow_handoff',
      failedStep: deliverable.pendingGateStepId,
      failedAt: new Date().toISOString(),
    })
    recomputeDeliverablePlan(store, failed)
    ctx.activity.audit('deliverable.workflow_complete_unapproved', 'system', { deliverableId: failed.id, taskId, reason })
    ctx.activity.log(failed.agent, `Workflow completed before approval for "${failed.title}": ${reason}`)
    await notifyWorkflowFailure(ctx, failed, reason)
    return failed
  }

  recomputeDeliverablePlan(store, deliverable)
  return deliverable
}

export function registerMessagingWorkflowBridge(
  store: MessagingContentStorage,
  ctx: PluginContext,
  getSettings: () => MessagingSettings,
  logger: WorkflowBridgeLogger,
): () => void {
  if (!ctx.hooks.has('workflows.approveGate') || !ctx.hooks.has('workflows.rejectGate')) {
    logger.warn('Messaging workflow bridge disabled; workflows gate hooks unavailable')
    return () => {}
  }

  const offGateReached = ctx.events.on('workflow.gate_reached', (_event, data) => {
    void handleWorkflowGateReached(store, ctx, data).catch(err => {
      logger.error('Messaging workflow gate handler failed', { err: err instanceof Error ? err.message : String(err) })
    })
  })
  const offGateApproved = ctx.events.on('workflow.gate_approved', (_event, data) => {
    void handleWorkflowGateApproved(store, ctx, data).catch(err => {
      logger.error('Messaging workflow gate approval handler failed', { err: err instanceof Error ? err.message : String(err) })
    })
  })
  const offGateRejected = ctx.events.on('workflow.gate_rejected', (_event, data) => {
    void handleWorkflowGateRejected(store, ctx, data).catch(err => {
      logger.error('Messaging workflow gate rejection handler failed', { err: err instanceof Error ? err.message : String(err) })
    })
  })
  const offComplete = ctx.events.on('workflow.complete', (_event, data) => {
    void handleWorkflowComplete(store, ctx, getSettings(), data).catch(err => {
      logger.error('Messaging workflow complete handler failed', { err: err instanceof Error ? err.message : String(err) })
    })
  })

  return () => {
    offGateReached()
    offGateApproved()
    offGateRejected()
    offComplete()
  }
}

export async function approveWorkflowGateForDeliverable(
  store: MessagingContentStorage,
  ctx: PluginContext,
  deliverableId: string,
  approver: ApprovalActor,
): Promise<WorkflowGateResolutionResult> {
  const deliverable = store.getDeliverable(deliverableId)
  if (!deliverable) return { ok: false, status: 404, error: 'Deliverable not found' }
  if (!ctx.hooks.has('workflows.approveGate')) return workflowGateUnavailable()

  const gate = workflowGateFields(deliverable)
  if ('ok' in gate) return gate

  const approved = store.updateDeliverable(deliverable.id, { status: 'approved' })
  recomputeDeliverablePlan(store, approved)

  try {
    await ctx.hooks.invoke('workflows.approveGate', {
      taskId: gate.taskId,
      stepId: gate.stepId,
      approver,
    })
    ctx.activity.audit('deliverable.workflow_gate_approved', approver.id, {
      deliverableId: approved.id,
      taskId: gate.taskId,
      stepId: gate.stepId,
    })
    return { ok: true, deliverable: approved }
  } catch (err) {
    const reverted = store.updateDeliverable(deliverable.id, { status: 'in_review' })
    recomputeDeliverablePlan(store, reverted)
    return {
      ok: false,
      status: 502,
      error: `Failed to approve workflow gate: ${err instanceof Error ? err.message : String(err)}`,
      deliverable: reverted,
    }
  }
}

export async function rejectWorkflowGateForDeliverable(
  store: MessagingContentStorage,
  ctx: PluginContext,
  deliverableId: string,
  reason: string,
  approver: ApprovalActor,
): Promise<WorkflowGateResolutionResult> {
  const deliverable = store.getDeliverable(deliverableId)
  if (!deliverable) return { ok: false, status: 404, error: 'Deliverable not found' }
  if (!ctx.hooks.has('workflows.rejectGate')) return workflowGateUnavailable()

  const gate = workflowGateFields(deliverable)
  if ('ok' in gate) return gate

  const rejected = store.updateDeliverable(deliverable.id, {
    status: 'changes_requested',
    rejectionNote: reason,
  })
  recomputeDeliverablePlan(store, rejected)

  try {
    await ctx.hooks.invoke('workflows.rejectGate', {
      taskId: gate.taskId,
      stepId: gate.stepId,
      reason,
      approver,
    })
    ctx.activity.audit('deliverable.workflow_gate_rejected', approver.id, {
      deliverableId: rejected.id,
      taskId: gate.taskId,
      stepId: gate.stepId,
    })
    return { ok: true, deliverable: rejected }
  } catch (err) {
    const reverted = store.updateDeliverable(deliverable.id, { status: deliverable.status })
    recomputeDeliverablePlan(store, reverted)
    return {
      ok: false,
      status: 502,
      error: `Failed to reject workflow gate: ${err instanceof Error ? err.message : String(err)}`,
      deliverable: reverted,
    }
  }
}
