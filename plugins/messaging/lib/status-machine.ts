import type { Deliverable, DeliverableStatus, PlanStatus } from '../types'

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
  'fanning_out',
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
  now = new Date(),
): Deliverable {
  return {
    ...deliverable,
    status: 'failed',
    failureReason,
    failedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}
