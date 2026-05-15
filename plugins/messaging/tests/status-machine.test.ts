import { describe, expect, it } from 'bun:test'
import { DeliverableSchema, PlanSchema, type Deliverable } from '../types'
import {
  DELIVERABLE_STATUSES,
  PLAN_STATUSES,
  isDeliverableTerminal,
  isPlanTerminal,
  markDeliverableFailed,
} from '../lib/status-machine'

const baseDeliverable: Deliverable = {
  id: 'deliv-1',
  planId: 'plan-1',
  channel: 'general',
  contentType: 'blog',
  tone: 'conversational',
  agent: 'basil',
  title: 'Taco Tuesday',
  brief: 'Draft a Taco Tuesday post.',
  publishAt: '2026-05-05T16:00:00-06:00',
  prepStartAt: '2026-05-02T16:00:00-06:00',
  status: 'planned',
  draft: {},
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
}

describe('messaging content-planning schemas', () => {
  it('parses the new deliverable shape including failure fields', () => {
    const parsed = DeliverableSchema.parse({
      ...baseDeliverable,
      status: 'failed',
      failureReason: 'Required video asset missing on Deliverable',
      failureStage: 'validation',
      failedStep: 'asset-check',
      failedAt: '2026-05-05T16:01:00Z',
    })

    expect(parsed.failureReason).toBe('Required video asset missing on Deliverable')
    expect(parsed.failureStage).toBe('validation')
    expect(parsed.failedStep).toBe('asset-check')
    expect(parsed.failedAt).toBe('2026-05-05T16:01:00Z')
  })

  it('parses the new plan shape', () => {
    const parsed = PlanSchema.parse({
      id: 'plan-1',
      title: 'Taco Tuesday',
      brief: 'A focused Tuesday promotion.',
      targetDate: '2026-05-05',
      agent: 'basil',
      status: 'planning',
      channels: [{
        id: 'general',
        channel: 'general',
        contentType: 'blog',
        publishAt: '2026-05-05T16:00:00Z',
      }],
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    })

    expect(parsed.status).toBe('planning')
  })
})

describe('messaging status machine helpers', () => {
  it('keeps status enumerations explicit', () => {
    expect(DELIVERABLE_STATUSES).toContain('changes_requested')
    expect(DELIVERABLE_STATUSES).toContain('overdue')
    expect(PLAN_STATUSES).toContain('needs_review')
    expect(PLAN_STATUSES).toContain('partially_published')
    expect(PLAN_STATUSES).not.toContain('fanning_out' as never)
  })

  it('identifies terminal deliverable and plan statuses', () => {
    expect(isDeliverableTerminal('published')).toBe(true)
    expect(isDeliverableTerminal('approved')).toBe(false)
    expect(isPlanTerminal('done')).toBe(true)
    expect(isPlanTerminal('scheduled')).toBe(false)
  })

  it('marks a deliverable failed with durable failure metadata', () => {
    const failed = markDeliverableFailed(baseDeliverable, 'delivery failed', 'delivery', {
      failedStep: 'deliver-content',
      now: new Date('2026-05-05T17:00:00Z'),
    })

    expect(failed.status).toBe('failed')
    expect(failed.failureReason).toBe('delivery failed')
    expect(failed.failureStage).toBe('delivery')
    expect(failed.failedStep).toBe('deliver-content')
    expect(failed.failedAt).toBe('2026-05-05T17:00:00.000Z')
    expect(failed.updatedAt).toBe('2026-05-05T17:00:00.000Z')
  })
})
