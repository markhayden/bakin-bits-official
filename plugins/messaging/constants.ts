import type { ContentTone, DeliverableStatus, PlanStatus } from './types'

export const TONE_LABELS: Record<ContentTone, string> = {
  energetic: 'Energetic',
  calm: 'Calm',
  educational: 'Educational',
  humorous: 'Humorous',
  inspiring: 'Inspiring',
  conversational: 'Conversational',
}

type StatusTone = 'neutral' | 'success' | 'attention' | 'danger' | 'accent'

export const PLAN_STATUS_TONE: Record<PlanStatus, StatusTone> = {
  needs_review: 'attention',
  planning: 'neutral',
  in_prep: 'accent',
  in_review: 'attention',
  scheduled: 'accent',
  overdue: 'danger',
  partially_published: 'accent',
  done: 'success',
  cancelled: 'neutral',
  failed: 'danger',
}

export const DELIVERABLE_STATUS_TONE: Record<DeliverableStatus, StatusTone> = {
  proposed: 'accent',
  planned: 'accent',
  in_prep: 'attention',
  in_review: 'attention',
  changes_requested: 'danger',
  approved: 'success',
  published: 'success',
  overdue: 'danger',
  cancelled: 'neutral',
  failed: 'danger',
}
