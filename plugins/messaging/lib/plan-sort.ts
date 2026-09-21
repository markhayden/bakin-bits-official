import type { Plan, PlanStatus } from '../types'

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  needs_review: 'Needs review', planning: 'Planning', in_prep: 'In production',
  in_review: 'In review', scheduled: 'Scheduled', overdue: 'Overdue',
  partially_published: 'Partially published', done: 'Published', cancelled: 'Cancelled', failed: 'Failed',
}

export const PLAN_SORT_FIELDS = { targetDate: 'Target date', title: 'Plan', status: 'Status', agent: 'Agent', channels: 'Channels' } as const
export type PlanSort = { field: keyof typeof PLAN_SORT_FIELDS; dir: 'asc' | 'desc' }

export function parsePlanSort(value: string): PlanSort {
  const [field, dir, extra] = value.split(':')
  return Object.hasOwn(PLAN_SORT_FIELDS, field) && (dir === 'asc' || dir === 'desc') && extra === undefined
    ? { field: field as PlanSort['field'], dir }
    : { field: 'targetDate', dir: 'asc' }
}

export function planTargetDate(value: string): string {
  return value.slice(0, 10)
}

export function sortPlans(rows: readonly Plan[], sort: PlanSort, agentName: (id: string) => string): Plan[] {
  const value = (plan: Plan): string => {
    switch (sort.field) {
      case 'targetDate': return planTargetDate(plan.targetDate)
      case 'status': return PLAN_STATUS_LABELS[plan.status] ?? plan.status
      case 'agent': return agentName(plan.agent)
      case 'channels': return plan.channels?.map(channel => channel.channel).join(', ') || 'None'
      default: return plan.title
    }
  }
  return [...rows].sort((a, b) => {
    const left = value(a)
    const right = value(b)
    // Unknown dates never outrank dated plans, even in descending order.
    if (sort.field === 'targetDate') {
      const leftMissing = !left || Number.isNaN(Date.parse(`${left}T00:00:00`))
      const rightMissing = !right || Number.isNaN(Date.parse(`${right}T00:00:00`))
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
    }
    const compared = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
    if (compared) return sort.dir === 'asc' ? compared : -compared
    return Number(b.status === 'needs_review') - Number(a.status === 'needs_review')
      || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
      || a.id.localeCompare(b.id)
  })
}
