/**
 * Compose drafts (spec D9 item 2): one per session, kept in this browser's
 * storage so they survive leaving the page. Storage may be absent or full,
 * and a draft longer than one paste can carry is not stored: the page then
 * keeps it only while it is open (and says so).
 */
export const DRAFT_LIMIT_BYTES = 65536
const key = (sessionId: string) => `bakin-terminal-compose:${sessionId}`
const bytes = (text: string) => new TextEncoder().encode(text).length

export function readDraft(sessionId: string, storage: () => Storage = () => window.localStorage): string {
  try {
    return storage().getItem(key(sessionId)) ?? ''
  } catch {
    // Storage unavailable (private mode, blocked): no saved draft.
    return ''
  }
}

/** Store `text` as the session's draft (empty removes it); false when it could not be kept. */
export function writeDraft(sessionId: string, text: string, storage: () => Storage = () => window.localStorage): boolean {
  try {
    // Too long to store: the stored copy would be stale, so it goes too.
    if (!text || bytes(text) > DRAFT_LIMIT_BYTES) { storage().removeItem(key(sessionId)); return !text }
    storage().setItem(key(sessionId), text)
    return true
  } catch {
    // Storage unavailable or full: the draft lives only in the open page.
    return false
  }
}
