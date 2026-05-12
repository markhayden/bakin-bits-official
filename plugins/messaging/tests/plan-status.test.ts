import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Deliverable, DeliverableStatus, Plan } from '../types'
import { MarkdownStorageAdapter } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'
import { derivePlanStatus, recomputePlanStatus } from '../lib/plan-status'

const basePlan: Plan = {
  id: 'plan-1',
  title: 'Taco Tuesday',
  brief: 'A focused Tuesday promotion.',
  targetDate: '2026-05-05',
  agent: 'basil',
  status: 'planning',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
}

function deliverable(status: DeliverableStatus, overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: `${status}-${Math.random().toString(36).slice(2, 6)}`,
    planId: 'plan-1',
    channel: 'general',
    contentType: 'blog',
    tone: 'conversational',
    agent: 'basil',
    title: `${status} deliverable`,
    brief: 'Test deliverable.',
    publishAt: '2026-05-05T16:00:00Z',
    prepStartAt: '2026-05-02T16:00:00Z',
    status,
    draft: {},
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

describe('derivePlanStatus', () => {
  it('keeps an explicit cancellation', () => {
    expect(derivePlanStatus({ ...basePlan, status: 'cancelled' }, [deliverable('approved')])).toBe('cancelled')
  })

  it('returns planning for a plan with zero deliverables', () => {
    expect(derivePlanStatus(basePlan, [])).toBe('planning')
  })

  it('preserves needs_review for a plan with zero deliverables', () => {
    expect(derivePlanStatus({ ...basePlan, status: 'needs_review' }, [])).toBe('needs_review')
  })

  it('returns fanning_out after content prep kickoff even before proposals arrive', () => {
    expect(derivePlanStatus({ ...basePlan, fanOutTaskId: 'task-1' }, [])).toBe('fanning_out')
  })

  it('returns fanning_out when content piece planning has proposed deliverables', () => {
    expect(derivePlanStatus({ ...basePlan, fanOutTaskId: 'task-1' }, [deliverable('proposed')])).toBe('fanning_out')
  })

  it('returns in_prep for planned, in_prep, or changes_requested work', () => {
    expect(derivePlanStatus(basePlan, [deliverable('planned'), deliverable('approved')])).toBe('in_prep')
    expect(derivePlanStatus(basePlan, [deliverable('changes_requested')])).toBe('in_prep')
  })

  it('returns in_review only after earlier prep statuses are clear', () => {
    expect(derivePlanStatus(basePlan, [deliverable('in_review'), deliverable('approved')])).toBe('in_review')
    expect(derivePlanStatus(basePlan, [deliverable('in_review'), deliverable('in_prep')])).toBe('in_prep')
  })

  it('returns scheduled when all non-terminal deliverables are approved', () => {
    expect(derivePlanStatus(basePlan, [deliverable('approved'), deliverable('cancelled')])).toBe('scheduled')
  })

  it('returns overdue when overdue work has no earlier blocking statuses', () => {
    expect(derivePlanStatus(basePlan, [deliverable('overdue'), deliverable('approved')])).toBe('overdue')
  })

  it('returns partially_published for mixed published and non-terminal states', () => {
    expect(derivePlanStatus(basePlan, [deliverable('published'), deliverable('approved')])).toBe('partially_published')
  })

  it('returns done for mixed terminal states when at least one deliverable published', () => {
    expect(derivePlanStatus(basePlan, [deliverable('published'), deliverable('failed'), deliverable('cancelled')])).toBe('done')
  })

  it('returns failed when all deliverables are failed or cancelled and none published', () => {
    expect(derivePlanStatus(basePlan, [deliverable('failed'), deliverable('cancelled')])).toBe('failed')
  })
})

describe('recomputePlanStatus', () => {
  it('persists the derived Plan status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-plan-status-'))
    try {
      const store = createMessagingContentStorage(new MarkdownStorageAdapter(dir))
      store.createPlan({
        id: 'plan-1',
        title: 'Taco Tuesday',
        brief: 'A focused Tuesday promotion.',
        targetDate: '2026-05-05',
        agent: 'basil',
      })
      store.createDeliverable({
        id: 'deliv-1',
        planId: 'plan-1',
        channel: 'general',
        contentType: 'blog',
        tone: 'conversational',
        agent: 'basil',
        title: 'Post',
        brief: 'Write a post.',
        publishAt: '2026-05-05T16:00:00Z',
        prepStartAt: '2026-05-02T16:00:00Z',
        status: 'approved',
      })

      expect(recomputePlanStatus(store, 'plan-1').status).toBe('scheduled')
      expect(store.getPlan('plan-1')?.status).toBe('scheduled')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
