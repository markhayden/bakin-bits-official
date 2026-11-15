/**
 * Conversation rows stored whole in a session: a row carried over from a
 * chat reads back exactly as written, and a session's own tool rows keep the
 * metadata their cards live in.
 */
import { describe, expect, test } from 'bun:test'
import type { ConversationMessage } from '@makinbakin/sdk/conversation'
import { conversationRowToSessionMessage, fitHandoffBatch, storedConversationRow } from '../lib/session-rows'
import { sessionMessageToConversation } from '../lib/session-to-conversation'
import type { SessionMessage } from '../types'

const project = { kind: 'projects:project', id: 'p-1', title: 'Launch plan', action: 'created' }
const ROWS: ConversationMessage[] = [
  { kind: 'handoff', ts: '2026-11-14T10:00:00.000Z', handoffId: 'c-1:t1:s-1', direction: 'in', peers: [{ entity: 'chat:chat', id: 'c-1', title: 'Launch chat' }], carried: 5 },
  { kind: 'user', ts: '2026-11-14T09:00:00.000Z', content: 'plan the posts' },
  { kind: 'assistant', ts: '2026-11-14T09:00:01.000Z', turnId: 't1', agentId: 'main', content: 'Here is a draft:\n```json\n{"title":"Post"}\n```\nShall I continue?' },
  { kind: 'tool', ts: '2026-11-14T09:00:02.000Z', turnId: 't1', agentId: 'main', callId: 'c9', toolName: 'bakin_exec_projects_create', status: 'completed', summary: 'p-1', metadata: { bakinEntities: [project] } },
  { kind: 'error', ts: '2026-11-14T09:00:03.000Z', turnId: 't1', message: 'runtime unavailable', errorKind: 'runtime_failed' },
  { kind: 'aborted', ts: '2026-11-14T09:00:04.000Z', turnId: 't2' },
]

describe('rows carried over from a chat', () => {
  test.each(ROWS.map((row) => [row.kind, row] as const))('a %s row reads back exactly as it was written', (_kind, row) => {
    const stored = conversationRowToSessionMessage(row, 'm-1')
    // Through JSON, as the session file stores it.
    const reloaded = JSON.parse(JSON.stringify(stored)) as SessionMessage
    expect(sessionMessageToConversation('basil', reloaded)).toEqual(row)
  })

  test('the stored message keeps the row\'s own timestamp and is not an agent or user message', () => {
    const stored = conversationRowToSessionMessage(ROWS[1]!, 'm-1')
    expect(stored).toMatchObject({ id: 'm-1', role: 'activity', kind: 'conversation_row', timestamp: '2026-11-14T09:00:00.000Z' })
    expect(storedConversationRow(stored)).toEqual(ROWS[1]!)
  })

  test('a damaged stored row is skipped, never rendered as something else', () => {
    const damaged: SessionMessage = { id: 'm', role: 'activity', kind: 'conversation_row', content: 'x', timestamp: 't', data: { nope: true } }
    expect(sessionMessageToConversation('basil', damaged)).toBeNull()
  })
})

describe("a session's own tool rows", () => {
  test('keep the turn id and the metadata their cards live in', () => {
    const message: SessionMessage = {
      id: 'm-2', role: 'activity', kind: 'tool_call', content: 'bakin_exec_messaging_plan_create: Launch', timestamp: '2026-11-14T11:00:00.000Z',
      data: { kind: 'tool', turnId: 't7', toolName: 'bakin_exec_messaging_plan_create', status: 'completed', summary: 'Launch', metadata: { bakinEntities: [{ kind: 'messaging:plan', id: 'pl-1', title: 'Launch', action: 'created' }] } },
    }
    expect(sessionMessageToConversation('basil', message)).toMatchObject({
      kind: 'tool', turnId: 't7', toolName: 'bakin_exec_messaging_plan_create',
      metadata: { bakinEntities: [{ kind: 'messaging:plan', id: 'pl-1', title: 'Launch', action: 'created' }] },
    })
  })
})

describe('fitHandoffBatch', () => {
  test('a batch within the cap is unchanged', () => {
    expect(fitHandoffBatch(ROWS, 300)).toBe(ROWS)
  })

  test('over the cap: the marker stays first, the newest rows are kept, the count is corrected', () => {
    const fitted = fitHandoffBatch(ROWS, 4)
    expect(fitted).toHaveLength(4)
    expect(fitted[0]).toMatchObject({ kind: 'handoff', carried: 3 })
    expect(fitted.slice(1)).toEqual(ROWS.slice(3))
  })
})
