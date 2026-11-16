/**
 * Conversation rows stored verbatim in a brainstorm session.
 *
 * A session's own turns are stored as its `SessionMessage` model (assistant
 * text split at ```json fences, tool calls as activity rows, timestamps
 * stamped at write). That is right for a session's turns and wrong for
 * history carried over from a chat: those rows must come back exactly as
 * they were written — original timestamps and authorship, cards on tool
 * rows, no fence splitting. A carried row is therefore stored whole, as an
 * activity message of kind `conversation_row` whose `data` IS the row; the
 * read mapper returns it untouched.
 */
import type { ConversationMessage } from '@makinbakin/sdk/conversation'
import type { SessionMessage } from '../types'

export const CONVERSATION_ROW_KIND = 'conversation_row'

/** A short label for surfaces that list a session's messages as text. */
function labelOf(row: ConversationMessage): string {
  if (row.kind === 'user' || row.kind === 'assistant') return row.content.slice(0, 500)
  if (row.kind === 'tool') return `${row.toolName}${row.summary ? `: ${row.summary}` : ''}`.slice(0, 500)
  if (row.kind === 'error') return `Turn failed: ${row.message}`.slice(0, 500)
  if (row.kind === 'handoff') return `Carried over from ${row.peers[0]?.title ?? 'a chat'}`
  return row.kind
}

/** Store one conversation row whole, keeping its own timestamp. */
export function conversationRowToSessionMessage(row: ConversationMessage, id: string): SessionMessage {
  return { id, role: 'activity', kind: CONVERSATION_ROW_KIND, content: labelOf(row), timestamp: row.ts, data: row }
}

/** The row a `conversation_row` message holds, or null when it is not one. */
export function storedConversationRow(message: SessionMessage): ConversationMessage | null {
  if (message.role !== 'activity' || message.kind !== CONVERSATION_ROW_KIND) return null
  const row = message.data as { kind?: unknown; ts?: unknown } | null | undefined
  return row && typeof row === 'object' && typeof row.kind === 'string' && typeof row.ts === 'string'
    ? row as ConversationMessage
    : null
}

/**
 * Fit a chat hand-off batch (the `in` marker, then the carried rows) into the
 * session's message cap: the marker stays first and the most recent carried
 * rows are kept, with the marker's `carried` count corrected to match.
 */
export function fitHandoffBatch<Row extends { kind: string }>(rows: Row[], cap: number): Row[] {
  const [marker, ...carried] = rows
  if (!marker || rows.length <= cap) return rows
  const kept = carried.slice(-(cap - 1))
  return [{ ...marker, carried: kept.length }, ...kept]
}

/**
 * Trim a session's messages to the cap without orphaning carried history.
 * Plain `slice(-cap)` evicts a hand-off's marker first, because it leads its
 * batch: the divider would vanish, a repeat of the hand-off would no longer
 * be recognised, and the carried rows would read as the session's own. While
 * any carried row survives, the marker is kept in front of them with its
 * `carried` count corrected.
 */
export function trimSessionMessages(messages: SessionMessage[], cap: number): SessionMessage[] {
  if (messages.length <= cap) return messages
  const drop = messages.length - cap
  let at = -1
  let marker: Extract<ConversationMessage, { kind: 'handoff' }> | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = storedConversationRow(messages[i]!)
    if (row?.kind === 'handoff' && row.direction === 'in') { at = i; marker = row; break }
  }
  if (!marker || at >= drop) return messages.slice(drop)
  const remaining = at + 1 + (marker.carried ?? 0) - (drop + 1)
  if (remaining <= 0) return messages.slice(drop)
  return [{ ...messages[at]!, data: { ...marker, carried: remaining } }, ...messages.slice(drop + 1)]
}
