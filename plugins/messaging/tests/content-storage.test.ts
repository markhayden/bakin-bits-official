import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MarkdownStorageAdapter } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'

function withStore(test: (storage: MarkdownStorageAdapter, root: ReturnType<typeof createMessagingContentStorage>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-content-storage-'))
  const storage = new MarkdownStorageAdapter(dir)
  try {
    test(storage, createMessagingContentStorage(storage))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('createMessagingContentStorage', () => {
  it('stores brainstorm sessions as one file per entity', () => {
    withStore((storage, store) => {
      const session = store.createBrainstormSession({
        id: 'session-1',
        agentId: 'basil',
        title: 'May planning',
        scope: 'next week',
      })

      expect(store.getBrainstormSession('session-1')).toMatchObject({
        id: 'session-1',
        status: 'active',
        createdAtPlanIds: [],
      })
      expect(storage.exists('messaging/sessions/session-1.json')).toBe(true)
      expect(session.messages).toEqual([])
    })
  })

  it('creates, updates, lists, and deletes plans', () => {
    withStore((_storage, store) => {
      store.createPlan({
        id: 'plan-1',
        title: 'Taco Tuesday',
        brief: 'A weekly taco feature.',
        targetDate: '2026-05-05',
        agent: 'basil',
        channels: [{
          id: 'general',
          channel: 'general',
          contentType: 'blog',
          publishAt: '2026-05-05T16:00:00Z',
        }],
      })

      const updated = store.updatePlan('plan-1', { status: 'needs_review', brief: undefined })

      expect(updated.status).toBe('needs_review')
      expect(updated.brief).toBe('A weekly taco feature.')
      expect(updated.channels?.[0]?.channel).toBe('general')
      expect(store.listPlans().map(plan => plan.id)).toEqual(['plan-1'])

      store.deletePlan('plan-1')
      expect(store.getPlan('plan-1')).toBeNull()
    })
  })

  it('stores deliverables, filters by planId, and supports quick posts', () => {
    withStore((_storage, store) => {
      store.createDeliverable({
        id: 'planned-1',
        planId: 'plan-1',
        channel: 'general',
        contentType: 'blog',
        tone: 'conversational',
        agent: 'basil',
        title: 'Planned post',
        brief: 'Write a planned post.',
        publishAt: '2026-05-05T16:00:00Z',
        prepStartAt: '2026-05-02T16:00:00Z',
      })
      store.createDeliverable({
        id: 'quick-1',
        planId: null,
        channel: 'general',
        contentType: 'announcement',
        tone: 'energetic',
        agent: 'basil',
        title: 'Quick post',
        brief: 'Ship it now.',
        publishAt: '2026-05-04T16:00:00Z',
        prepStartAt: '2026-05-04T15:00:00Z',
      })

      expect(store.listDeliverables({ planId: 'plan-1' }).map(deliverable => deliverable.id)).toEqual(['planned-1'])
      expect(store.listDeliverables({ planId: null }).map(deliverable => deliverable.id)).toEqual(['quick-1'])
    })
  })

  it('deep-merges deliverable draft updates and treats null as an explicit clear', () => {
    withStore((_storage, store) => {
      store.createDeliverable({
        id: 'deliv-1',
        planId: 'plan-1',
        channel: 'general',
        contentType: 'blog',
        tone: 'conversational',
        agent: 'basil',
        title: 'Draft merge',
        brief: 'Merge draft updates.',
        publishAt: '2026-05-05T16:00:00Z',
        prepStartAt: '2026-05-02T16:00:00Z',
        draft: { caption: 'first caption' },
      })

      store.updateDeliverable('deliv-1', { title: undefined, draft: { imageFilename: 'taco.png' } })
      const cleared = store.updateDeliverable('deliv-1', { draft: { caption: null } })

      expect(cleared.title).toBe('Draft merge')
      expect(cleared.draft).toEqual({
        caption: null,
        imageFilename: 'taco.png',
      })
    })
  })

  it('uses atomic writes without leaving temp artifacts', () => {
    withStore((storage, store) => {
      store.createPlan({
        id: 'plan-atomic',
        title: 'Atomic',
        brief: 'Write atomically.',
        targetDate: '2026-05-05',
        agent: 'basil',
      })
      store.updatePlan('plan-atomic', { title: 'Atomic update' })

      expect(storage.list('messaging/plans').filter(file => file.includes('.tmp-'))).toEqual([])
    })
  })
})
