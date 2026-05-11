import type { ContentTone, DeliverableStatus, PlanStatus } from './types'

export const TONE_LABELS: Record<ContentTone, string> = {
  energetic: 'Energetic',
  calm: 'Calm',
  educational: 'Educational',
  humorous: 'Humorous',
  inspiring: 'Inspiring',
  conversational: 'Conversational',
}

export const PLAN_STATUS_BADGE: Record<PlanStatus, string> = {
  planning: 'bg-zinc-500/20 text-zinc-400',
  fanning_out: 'bg-violet-500/20 text-violet-300',
  in_prep: 'bg-amber-500/20 text-amber-300',
  in_review: 'bg-yellow-500/20 text-yellow-300',
  scheduled: 'bg-sky-500/20 text-sky-300',
  overdue: 'bg-orange-500/20 text-orange-300',
  partially_published: 'bg-teal-500/20 text-teal-300',
  done: 'bg-emerald-500/20 text-emerald-300',
  cancelled: 'bg-zinc-500/20 text-zinc-400',
  failed: 'bg-red-500/20 text-red-400',
}

export const DELIVERABLE_STATUS_BADGE: Record<DeliverableStatus, string> = {
  proposed: 'bg-violet-500/20 text-violet-300',
  planned: 'bg-sky-500/20 text-sky-300',
  in_prep: 'bg-amber-500/20 text-amber-300',
  in_review: 'bg-yellow-500/20 text-yellow-300',
  changes_requested: 'bg-orange-500/20 text-orange-300',
  approved: 'bg-emerald-500/20 text-emerald-300',
  published: 'bg-teal-500/20 text-teal-300',
  overdue: 'bg-orange-500/20 text-orange-300',
  cancelled: 'bg-zinc-500/20 text-zinc-400',
  failed: 'bg-red-500/20 text-red-400',
}
