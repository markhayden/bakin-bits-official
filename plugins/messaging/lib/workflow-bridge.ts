import type { ApprovalProvenance } from '@makinbakin/sdk/routing'
import type { PluginContext } from '@makinbakin/sdk/types'
import type { Deliverable, MessagingSettings } from '../types'
import type { MessagingContentStorage } from './content-storage'
import { contentTypeFor } from './content-type-lookup'
import { recomputePlanStatus } from './plan-status'
import { publishDeliverableNow } from './publish'
import { isDeliverableTerminal } from './status-machine'

export type { ApprovalProvenance }

/** Who to name in an audit/task line: the provider's user id, else the channel. */
export function provenanceActorId(provenance: ApprovalProvenance | null): string {
  return provenance?.actor.id ?? provenance?.channel ?? 'workflow'
}

/** The core gate hook's answer (it folds refusals into `success: false` — never a throw). */
interface GateHookResult {
  success?: boolean
  errors?: string[]
  status?: number
  code?: string
}

export type WorkflowGateResolutionResult =
  | { ok: true; deliverable: Deliverable }
  | { ok: false; error: string; status: number; code?: string; deliverable?: Deliverable }

type WorkflowGateResolutionFailure = Extract<WorkflowGateResolutionResult, { ok: false }>

interface WorkflowBridgeLogger {
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function provenanceFromEvent(data: Record<string, unknown>): ApprovalProvenance | null {
  const value = data.provenance
  if (!value || typeof value !== 'object') return null
  const provenance = value as Partial<ApprovalProvenance>
  return typeof provenance.channel === 'string' && provenance.actor && typeof provenance.actor === 'object' && typeof provenance.evidence === 'string'
    ? provenance as ApprovalProvenance
    : null
}

function findDeliverableByTaskId(store: MessagingContentStorage, taskId: string): Deliverable | null {
  return store.listDeliverables().find(deliverable => deliverable.taskId === taskId) ?? null
}

function recomputeDeliverablePlan(store: MessagingContentStorage, deliverable: Deliverable): void {
  if (deliverable.planId) recomputePlanStatus(store, deliverable.planId)
}

const PUBLISH_FAILURE_TASK_PURPOSE = 'publish-failure'
const CLOSED_TASK_COLUMNS = new Set(['done', 'archived'])

async function ensureWorkflowPublishFailureTask(ctx: PluginContext, deliverable: Deliverable, reason: string): Promise<void> {
  const source = {
    pluginId: 'messaging',
    entityType: 'deliverable',
    entityId: deliverable.id,
    purpose: PUBLISH_FAILURE_TASK_PURPOSE,
  }
  try {
    const tasks = await ctx.tasks.list()
    const existing = tasks.find(task =>
      task.source?.pluginId === source.pluginId &&
      task.source?.entityType === source.entityType &&
      task.source?.entityId === source.entityId &&
      task.source?.purpose === source.purpose &&
      !CLOSED_TASK_COLUMNS.has(task.column),
    )
    const task = existing ?? await ctx.tasks.create({
      title: `Repair failed publish: ${deliverable.title}`,
      description: [
        `Deliverable: ${deliverable.id}`,
        `Original task: ${deliverable.taskId ?? 'none'}`,
        `Channel: ${deliverable.channel}`,
        `Failure: ${reason}`,
        '',
        'Review the failed Deliverable, then retry delivery or reopen prep.',
      ].join('\n'),
      column: 'blocked',
      agent: deliverable.agent,
      createdBy: 'messaging',
      source,
    })
    await ctx.tasks.update(task.id, { column: 'blocked', blockedReason: reason })
    await ctx.tasks.appendLog(task.id, {
      timestamp: new Date().toISOString(),
      author: 'system',
      message: `Publish failed after workflow completion: ${reason}`,
      data: { deliverableId: deliverable.id, originalTaskId: deliverable.taskId },
    })
    if (!existing) {
      ctx.activity.audit('deliverable.publish_failure_task_created', 'system', {
        deliverableId: deliverable.id,
        taskId: task.id,
        originalTaskId: deliverable.taskId,
      })
    }
  } catch (err) {
    ctx.activity.audit('deliverable.publish_failure_task_failed', 'system', {
      deliverableId: deliverable.id,
      originalTaskId: deliverable.taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
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

  const provenance = provenanceFromEvent(data)
  const updated = store.updateDeliverable(deliverable.id, { status: 'approved' })
  recomputeDeliverablePlan(store, updated)
  ctx.activity.audit('deliverable.workflow_gate_approved', provenanceActorId(provenance), {
    deliverableId: updated.id,
    taskId,
    stepId,
    provenance,
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

  const provenance = provenanceFromEvent(data)
  const reason = stringField(data, 'reason') ?? ''
  const updated = store.updateDeliverable(deliverable.id, {
    status: 'changes_requested',
    rejectionNote: reason || deliverable.rejectionNote,
  })
  recomputeDeliverablePlan(store, updated)
  ctx.activity.audit('deliverable.workflow_gate_rejected', provenanceActorId(provenance), {
    deliverableId: updated.id,
    taskId,
    stepId,
    reason,
    provenance,
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
    if (!result.ok) await ensureWorkflowPublishFailureTask(ctx, result.deliverable, result.reason)
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
    await ensureWorkflowPublishFailureTask(ctx, failed, reason)
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
  provenance: ApprovalProvenance,
): Promise<WorkflowGateResolutionResult> {
  const deliverable = store.getDeliverable(deliverableId)
  if (!deliverable) return { ok: false, status: 404, error: 'Deliverable not found' }
  if (!ctx.hooks.has('workflows.approveGate')) return workflowGateUnavailable()

  const gate = workflowGateFields(deliverable)
  if ('ok' in gate) return gate

  // Nothing is written before core decides: a refused decision (an agent,
  // an undeclared caller) must change nothing here. On success the gate's
  // own `workflow.gate_approved` event — emitted before `workflow.complete`
  // — moves the Deliverable (handleWorkflowGateApproved), so a gate that
  // completes the workflow still publishes an approved Deliverable.
  try {
    const result = await ctx.hooks.invoke<GateHookResult>('workflows.approveGate', {
      taskId: gate.taskId,
      stepId: gate.stepId,
      provenance,
    })
    if (!result?.success) return gateRefused(result, 'The workflow gate was not approved', deliverable)
    ctx.activity.audit('deliverable.workflow_gate_approved', provenanceActorId(provenance), {
      deliverableId: deliverable.id,
      taskId: gate.taskId,
      stepId: gate.stepId,
      provenance,
    })
    return { ok: true, deliverable: store.getDeliverable(deliverable.id) ?? deliverable }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Failed to approve workflow gate: ${err instanceof Error ? err.message : String(err)}`,
      deliverable: store.getDeliverable(deliverable.id) ?? deliverable,
    }
  }
}

export async function rejectWorkflowGateForDeliverable(
  store: MessagingContentStorage,
  ctx: PluginContext,
  deliverableId: string,
  reason: string,
  provenance: ApprovalProvenance,
): Promise<WorkflowGateResolutionResult> {
  const deliverable = store.getDeliverable(deliverableId)
  if (!deliverable) return { ok: false, status: 404, error: 'Deliverable not found' }
  if (!ctx.hooks.has('workflows.rejectGate')) return workflowGateUnavailable()

  const gate = workflowGateFields(deliverable)
  if ('ok' in gate) return gate

  // As with approval: core decides first; the `workflow.gate_rejected` event
  // records changes_requested + the note (handleWorkflowGateRejected).
  try {
    const result = await ctx.hooks.invoke<GateHookResult>('workflows.rejectGate', {
      taskId: gate.taskId,
      stepId: gate.stepId,
      reason,
      provenance,
    })
    if (!result?.success) return gateRefused(result, 'The workflow gate was not rejected', deliverable)
    ctx.activity.audit('deliverable.workflow_gate_rejected', provenanceActorId(provenance), {
      deliverableId: deliverable.id,
      taskId: gate.taskId,
      stepId: gate.stepId,
      provenance,
    })
    return { ok: true, deliverable: store.getDeliverable(deliverable.id) ?? deliverable }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Failed to reject workflow gate: ${err instanceof Error ? err.message : String(err)}`,
      deliverable: store.getDeliverable(deliverable.id) ?? deliverable,
    }
  }
}

/** The hook's refusal, unchanged: its status and machine-readable code (#898). */
function gateRefused(result: GateHookResult | undefined, fallback: string, deliverable: Deliverable): WorkflowGateResolutionFailure {
  return {
    ok: false,
    status: result?.status ?? 409,
    error: result?.errors?.[0] ?? fallback,
    ...(result?.code ? { code: result.code } : {}),
    deliverable,
  }
}
