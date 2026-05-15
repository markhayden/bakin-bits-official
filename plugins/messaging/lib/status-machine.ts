import type { Deliverable, DeliverableFailureStage, DeliverableStatus, PlanStatus } from '../types'

export const DELIVERABLE_STATUSES: readonly DeliverableStatus[] = [
  'proposed',
  'planned',
  'in_prep',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'overdue',
  'cancelled',
  'failed',
] as const

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'needs_review',
  'planning',
  'in_prep',
  'in_review',
  'scheduled',
  'overdue',
  'partially_published',
  'done',
  'cancelled',
  'failed',
] as const

const TERMINAL_DELIVERABLE_STATUSES = new Set<DeliverableStatus>(['published', 'cancelled', 'failed'])
const TERMINAL_PLAN_STATUSES = new Set<PlanStatus>(['done', 'cancelled', 'failed'])

export function isDeliverableTerminal(status: DeliverableStatus): boolean {
  return TERMINAL_DELIVERABLE_STATUSES.has(status)
}

export function isPlanTerminal(status: PlanStatus): boolean {
  return TERMINAL_PLAN_STATUSES.has(status)
}

export function markDeliverableFailed(
  deliverable: Deliverable,
  failureReason: string,
  failureStage: DeliverableFailureStage,
  options: { failedStep?: string; now?: Date } = {},
): Deliverable {
  const now = options.now ?? new Date()
  return {
    ...deliverable,
    status: 'failed',
    failureReason,
    failureStage,
    failedStep: options.failedStep,
    failedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

export function clearDeliverableFailure(deliverable: Deliverable, now = new Date()): Deliverable {
  const { failureReason: _failureReason, failureStage: _failureStage, failedStep: _failedStep, failedAt: _failedAt, ...rest } = deliverable
  return {
    ...rest,
    updatedAt: now.toISOString(),
  }
}
