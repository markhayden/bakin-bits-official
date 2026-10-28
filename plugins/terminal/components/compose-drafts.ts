/**
 * Compose drafts (spec D9 item 2): one per session, in this browser's
 * storage, which may be absent or full — a draft then lives only as long
 * as the sheet. Bounded: a longer draft is not kept.
 */
export const DRAFT_LIMIT = 64 * 1024
const key = (sessionId: string) => `bakin-terminal-compose:${sessionId}`

export function readDraft(sessionId: string, storage: () => Storage = () => window.localStorage): string {
  try {
    return storage().getItem(key(sessionId)) ?? ''
  } catch {
    // Storage unavailable (private mode, blocked): no saved draft.
    return ''
  }
}

/** Keep `text` as the session's draft; empty (or past the limit) removes it. */
export function writeDraft(sessionId: string, text: string, storage: () => Storage = () => window.localStorage): void {
  try {
    if (!text || text.length > DRAFT_LIMIT) storage().removeItem(key(sessionId))
    else storage().setItem(key(sessionId), text)
  } catch {
    // Storage unavailable or full: the draft stays in the open sheet only.
  }
}
