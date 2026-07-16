/**
 * messaging.scheduledEvents provider (bakin#191) — deliverable publish dates
 * appear on Bakin's Schedule calendars as read-only domain events, and
 * messaging.rescheduleEvent moves publishAt through the SAME semantics as the
 * PUT /deliverables/:id route (prepStartAt re-derived unless overridden,
 * linked plan recomputed). Schedule never writes messaging data itself.
 *
 * Contract types are structural (hook convention) — defined locally until
 * the next published @makinbakin/sdk exports ScheduledDomainEvent et al.
 */
import type { Deliverable, DeliverableStatus } from '../types'

export interface ScheduledEventsQuery {
  from: string
  to: string
}

export interface ScheduledDomainEvent {
  id: string
  pluginId: string
  title: string
  startsAt?: string
  endsAt?: string
  dueAt?: string
  kind: string
  status?: string
  url?: string
  reschedulable?: boolean
  metadata?: Record<string, unknown>
}

export type ScheduledEventRescheduleResult = { ok: true } | { ok: false; error: string }

/** Terminal states whose publish date no longer means anything movable. */
const UNRESCHEDULABLE: DeliverableStatus[] = ['published', 'cancelled', 'failed']

export function listMessagingScheduledEvents(
  listDeliverables: () => Deliverable[],
  query: ScheduledEventsQuery,
): ScheduledDomainEvent[] {
  const fromMs = Date.parse(query.from)
  const toMs = Date.parse(query.to)
  const events: ScheduledDomainEvent[] = []
  for (const deliverable of listDeliverables()) {
    const publishMs = Date.parse(deliverable.publishAt)
    if (!Number.isFinite(publishMs) || publishMs < fromMs || publishMs >= toMs) continue
    events.push({
      id: deliverable.id,
      pluginId: 'messaging',
      title: deliverable.title,
      startsAt: new Date(publishMs).toISOString(),
      kind: 'publish',
      status: deliverable.status,
      url: '/messaging/calendar',
      reschedulable: !UNRESCHEDULABLE.includes(deliverable.status),
      metadata: { channel: deliverable.channel, contentType: deliverable.contentType, agent: deliverable.agent },
    })
  }
  return events
}

export interface RescheduleDeps {
  getDeliverable: (id: string) => Deliverable | null
  updateDeliverable: (id: string, patch: Partial<Deliverable>) => Deliverable
  /** Same derivation the PUT route uses (prep lead time per content type). */
  derivePrepStartAt: (publishAt: string, contentTypeId: string) => string
  recomputeLinkedPlan: (planId: string | null | undefined) => void
  audit: (event: string, actor: string, data: Record<string, unknown>) => void
}

export async function rescheduleMessagingDeliverable(
  deps: RescheduleDeps,
  input: { eventId: string; to: string },
): Promise<ScheduledEventRescheduleResult> {
  const toMs = Date.parse(input.to)
  if (!Number.isFinite(toMs)) return { ok: false, error: `Not an ISO instant: ${input.to}` }
  const deliverable = deps.getDeliverable(input.eventId)
  if (!deliverable) return { ok: false, error: `Unknown deliverable ${input.eventId}` }
  if (UNRESCHEDULABLE.includes(deliverable.status)) {
    return { ok: false, error: `A ${deliverable.status} deliverable cannot be rescheduled` }
  }

  const publishAt = new Date(toMs).toISOString()
  deps.updateDeliverable(deliverable.id, {
    publishAt,
    // Mirror PUT /deliverables/:id: a manual override sticks; otherwise the
    // prep window follows the new publish date.
    ...(deliverable.prepStartAtOverride
      ? {}
      : { prepStartAt: deps.derivePrepStartAt(publishAt, deliverable.contentType) }),
  })
  deps.recomputeLinkedPlan(deliverable.planId)
  deps.audit('deliverable.rescheduled', 'system', { deliverableId: deliverable.id, publishAt, via: 'schedule-calendar' })
  deps.audit('scheduled_events_changed', 'system', { deliverableId: deliverable.id })
  return { ok: true }
}
