/**
 * messaging.scheduledEvents provider (bakin#191) — publish dates in range
 * become calendar events (terminal statuses unreschedulable), and the
 * reschedule verb mirrors PUT /deliverables/:id semantics: publishAt moves,
 * prepStartAt re-derives unless overridden, the linked plan recomputes.
 */
import { describe, it, expect } from 'bun:test'
import { listMessagingScheduledEvents, rescheduleMessagingDeliverable, type RescheduleDeps } from '../lib/scheduled-events'
import type { Deliverable, DeliverableStatus } from '../types'

function deliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'del-1',
    planId: 'plan-1',
    channel: 'general',
    contentType: 'blog-post',
    tone: 'casual',
    agent: 'pixel',
    title: 'Launch post',
    brief: 'Announce it',
    publishAt: '2026-07-03T15:00:00.000Z',
    prepStartAt: '2026-07-01T15:00:00.000Z',
    status: 'planned' as DeliverableStatus,
    draft: { content: '', assets: [] },
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  } as Deliverable
}

const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }

describe('listMessagingScheduledEvents', () => {
  it('maps in-range publish dates to events with owner metadata', () => {
    const events = listMessagingScheduledEvents(() => [
      deliverable(),
      deliverable({ id: 'del-out', publishAt: '2026-08-01T00:00:00.000Z' }),
    ], RANGE)
    expect(events.map(e => e.id)).toEqual(['del-1'])
    expect(events[0]!.pluginId).toBe('messaging')
    expect(events[0]!.kind).toBe('publish')
    expect(events[0]!.startsAt).toBe('2026-07-03T15:00:00.000Z')
    expect(events[0]!.status).toBe('planned')
    expect(events[0]!.reschedulable).toBe(true)
    expect(events[0]!.url).toBe('/messaging/calendar')
  })

  it('terminal statuses stay visible but are not reschedulable', () => {
    const events = listMessagingScheduledEvents(() => [
      deliverable({ id: 'del-pub', status: 'published' as DeliverableStatus }),
      deliverable({ id: 'del-overdue', status: 'overdue' as DeliverableStatus }),
    ], RANGE)
    expect(events.find(e => e.id === 'del-pub')!.reschedulable).toBe(false)
    expect(events.find(e => e.id === 'del-overdue')!.reschedulable).toBe(true)
  })
})

describe('rescheduleMessagingDeliverable', () => {
  function makeDeps(existing: Deliverable) {
    const updates: Array<{ id: string; patch: Partial<Deliverable> }> = []
    const recomputed: Array<string | null | undefined> = []
    const audits: string[] = []
    const deps: RescheduleDeps = {
      getDeliverable: (id) => (id === existing.id ? existing : null),
      updateDeliverable: (id, patch) => { updates.push({ id, patch }); return { ...existing, ...patch } },
      derivePrepStartAt: (publishAt) => `derived:${publishAt}`,
      recomputeLinkedPlan: (planId) => { recomputed.push(planId) },
      audit: (event) => { audits.push(event) },
    }
    return { deps, updates, recomputed, audits }
  }

  it('moves publishAt, re-derives prepStartAt, recomputes the plan, audits', async () => {
    const { deps, updates, recomputed, audits } = makeDeps(deliverable())
    const result = await rescheduleMessagingDeliverable(deps, { eventId: 'del-1', to: '2026-07-05T15:00:00.000Z' })
    expect(result).toEqual({ ok: true })
    expect(updates).toEqual([{
      id: 'del-1',
      patch: { publishAt: '2026-07-05T15:00:00.000Z', prepStartAt: 'derived:2026-07-05T15:00:00.000Z' },
    }])
    expect(recomputed).toEqual(['plan-1'])
    expect(audits).toEqual(['deliverable.rescheduled', 'scheduled_events_changed'])
  })

  it('a manual prepStartAt override sticks (not re-derived)', async () => {
    const { deps, updates } = makeDeps(deliverable({ prepStartAtOverride: '2026-06-30T00:00:00.000Z' }))
    await rescheduleMessagingDeliverable(deps, { eventId: 'del-1', to: '2026-07-05T15:00:00.000Z' })
    expect(updates[0]!.patch).toEqual({ publishAt: '2026-07-05T15:00:00.000Z' })
  })

  it('rejects terminal statuses, unknown ids, and malformed instants without mutating', async () => {
    const published = makeDeps(deliverable({ status: 'published' as DeliverableStatus }))
    expect((await rescheduleMessagingDeliverable(published.deps, { eventId: 'del-1', to: '2026-07-05T00:00:00Z' })).ok).toBe(false)
    expect(published.updates).toEqual([])

    const { deps, updates } = makeDeps(deliverable())
    expect((await rescheduleMessagingDeliverable(deps, { eventId: 'ghost', to: '2026-07-05T00:00:00Z' })).ok).toBe(false)
    expect((await rescheduleMessagingDeliverable(deps, { eventId: 'del-1', to: 'someday' })).ok).toBe(false)
    expect(updates).toEqual([])
  })
})
