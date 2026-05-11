import type { Deliverable, Plan, PlanStatus } from '../types'
import type { MessagingContentStorage } from './content-storage'
import { isDeliverableTerminal } from './status-machine'

const PRE_REVIEW_STATUSES = new Set(['proposed', 'planned', 'in_prep', 'changes_requested'])
const PRE_SCHEDULE_STATUSES = new Set(['proposed', 'planned', 'in_prep', 'changes_requested', 'in_review'])

export function derivePlanStatus(plan: Plan, deliverables: Deliverable[]): PlanStatus {
  if (plan.status === 'cancelled') return 'cancelled'
  if (plan.status === 'failed') return 'failed'
  if (deliverables.length === 0) return 'planning'

  const statuses = deliverables.map(deliverable => deliverable.status)
  const allTerminal = statuses.every(isDeliverableTerminal)
  const hasPublished = statuses.includes('published')
  const hasNonTerminal = statuses.some(status => !isDeliverableTerminal(status))

  if (allTerminal) {
    if (statuses.every(status => status === 'cancelled')) return 'cancelled'
    if (hasPublished) return 'done'
    return 'failed'
  }

  if (hasPublished && hasNonTerminal) return 'partially_published'

  if (statuses.includes('overdue') && !statuses.some(status => PRE_SCHEDULE_STATUSES.has(status))) {
    return 'overdue'
  }

  if (statuses.includes('in_review') && !statuses.some(status => PRE_REVIEW_STATUSES.has(status))) {
    return 'in_review'
  }

  if (
    !statuses.includes('proposed') &&
    statuses.some(status => status === 'planned' || status === 'in_prep' || status === 'changes_requested')
  ) {
    return 'in_prep'
  }

  const nonTerminal = deliverables.filter(deliverable => !isDeliverableTerminal(deliverable.status))
  if (nonTerminal.length > 0 && nonTerminal.every(deliverable => deliverable.status === 'approved')) {
    return 'scheduled'
  }

  if (plan.fanOutTaskId && statuses.includes('proposed')) return 'fanning_out'

  return 'planning'
}

export function recomputePlanStatus(store: MessagingContentStorage, planId: string): Plan {
  const plan = store.getPlan(planId)
  if (!plan) throw new Error(`Plan ${planId} not found`)
  const nextStatus = derivePlanStatus(plan, store.listDeliverables({ planId }))
  if (plan.status === nextStatus) return plan
  return store.updatePlan(planId, { status: nextStatus })
}
