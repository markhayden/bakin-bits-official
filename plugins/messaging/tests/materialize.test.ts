import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrainstormSession } from '../types'
import { MarkdownStorageAdapter } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'
import { materializeApprovedProposals } from '../lib/materialize'

function makeSession(): BrainstormSession {
  return {
    id: 'session-1',
    agentId: 'basil',
    title: 'May planning',
    status: 'active',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    messages: [],
    proposals: [
      {
        id: 'proposal-1',
        messageId: 'message-1',
        revision: 1,
        agentId: 'basil',
        title: 'Taco Tuesday',
        targetDate: '2026-05-19',
        brief: 'A taco topic.',
        suggestedChannels: ['blog', 'x'],
        status: 'approved',
      },
      {
        id: 'proposal-2',
        messageId: 'message-1',
        revision: 1,
        agentId: 'basil',
        title: 'Rejected',
        targetDate: '2026-05-20',
        brief: 'Skip this.',
        status: 'rejected',
      },
    ],
  }
}

describe('materializeApprovedProposals', () => {
  it('creates Plans from approved proposals and links them back to the session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-materialize-'))
    try {
      const store = createMessagingContentStorage(new MarkdownStorageAdapter(dir))
      const session = makeSession()

      const result = materializeApprovedProposals(session, store)

      expect(result.planIds.length).toBe(1)
      const plan = store.getPlan(result.planIds[0])!
      expect(plan).toMatchObject({
        title: 'Taco Tuesday',
        targetDate: '2026-05-19',
        agent: 'basil',
        sourceSessionId: 'session-1',
        suggestedChannels: ['blog', 'x'],
      })
      expect(session.proposals[0].planId).toBe(plan.id)
      expect(session.createdAtPlanIds).toEqual([plan.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent for proposals that already have a planId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-materialize-'))
    try {
      const store = createMessagingContentStorage(new MarkdownStorageAdapter(dir))
      const session = makeSession()
      materializeApprovedProposals(session, store)

      expect(materializeApprovedProposals(session, store)).toEqual({ planIds: [] })
      expect(store.listPlans().length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
