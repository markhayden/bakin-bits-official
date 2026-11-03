import type { AttentionState, AttentionSummary, Session } from '../lib/contracts'

/**
 * Attention in the browser (spec item 5 delivery): chips, the nav badge, and
 * what a change announces. Pure rules; the provider and the page apply them.
 */
type Tone = 'attention' | 'success' | 'neutral'
const CHIPS: Record<AttentionState, { label: string; tone: Tone; title: string }> = {
  'needs-you': { label: 'Needs you', tone: 'attention', title: 'Waiting for your answer (a permission or question prompt)' },
  'turn-finished': { label: 'Your turn', tone: 'success', title: 'The turn finished' },
  working: { label: 'Working', tone: 'neutral', title: 'Working on its turn' },
}

/** A running session's attention chip; none for a shell, an unknown state, or an ended session. */
export function attentionChip(session: Pick<Session, 'state' | 'attention'>): { label: string; tone: Tone; title: string; acknowledged: boolean } | undefined {
  if (session.state !== 'running' || !session.attention) return undefined
  return { ...CHIPS[session.attention.state], acknowledged: session.attention.acknowledgedAt !== undefined }
}

/** States that want the operator: they count for the badge until acknowledged. */
export function wantsYou(session: Pick<Session, 'state' | 'attention'>): boolean {
  const state = session.attention?.state
  return session.state === 'running' && (state === 'needs-you' || state === 'turn-finished') && session.attention?.acknowledgedAt === undefined
}

/** The nav badge: how many sessions want you; attention tone while any needs an answer. */
export function attentionBadge(sessions: Array<Pick<Session, 'state' | 'attention'>>): { count: number; tone: 'attention' | 'success' } | null {
  const waiting = sessions.filter(wantsYou)
  if (!waiting.length) return null
  return { count: waiting.length, tone: waiting.some((session) => session.attention?.state === 'needs-you') ? 'attention' : 'success' }
}

/** The session open at `pathname` (`/terminal/<id>`), if any. */
export function visibleSessionId(pathname: string): string | undefined {
  const match = /^\/terminal\/([^/]+)\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : undefined
}

export interface Announcement {
  sessionId: string
  /** One id per occurrence, across tabs (a tab that already told it skips it). */
  key: string
  title: string
  body: string
  href: string
}

const programName = (program: Session['program']) => program === 'claude' ? 'Claude Code' : program === 'codex' ? 'Codex' : 'The program'

/**
 * What changed between two reads of `GET /attention`: each new occurrence of
 * needs-you or your turn not yet acknowledged, and each new bell. The first
 * read (`previous` undefined) is where telling starts, never a burst of old
 * states. Every path — an event, a reconnect, the periodic read — goes
 * through this, so one missed while disconnected is told on the next read.
 */
export function announcements(previous: ReadonlyMap<string, AttentionSummary> | undefined, next: AttentionSummary[]): Announcement[] {
  if (!previous) return []
  const told: Announcement[] = []
  for (const session of next) {
    if (session.state !== 'running') continue
    const before = previous.get(session.id)
    const href = `/terminal/${encodeURIComponent(session.id)}`
    const attention = session.attention
    if (attention && wantsYou(session) && before?.attention?.occurrence !== attention.occurrence) {
      const needsYou = attention.state === 'needs-you'
      told.push({
        sessionId: session.id,
        key: `attention:${session.id}:${attention.occurrence}`,
        title: needsYou ? `${session.title} needs you` : `Your turn in ${session.title}`,
        body: needsYou ? `${programName(session.program)} is waiting for your answer.` : `${programName(session.program)} finished its turn.`,
        href,
      })
    }
    if (session.bellAt !== undefined && session.bellAt !== before?.bellAt) {
      told.push({ sessionId: session.id, key: `bell:${session.id}:${session.bellAt}`, title: `${session.title} rang`, body: 'The terminal rang its bell.', href })
    }
  }
  return told
}

const WATCHING_PREFIX = 'bakin-terminal-watching:'
/** A tab watching a session says so this often; an older word is from a tab that went away. */
export const WATCHING_BEAT_MS = 5_000
const WATCHING_STALE_MS = 3 * WATCHING_BEAT_MS
/**
 * Which session a tab on this device has open and focused (spec: suppression
 * is session-specific; the host only checks document focus). Each tab writes
 * only its own key — `<prefix><tab>` → `{ sessionId, at }` — so tabs never
 * overwrite each other's word; it removes it when it stops watching.
 */
export function setWatching(tab: string, sessionId: string | undefined, now = Date.now()): void {
  try {
    if (sessionId) localStorage.setItem(WATCHING_PREFIX + tab, JSON.stringify({ sessionId, at: now }))
    else localStorage.removeItem(WATCHING_PREFIX + tab)
  } catch { /* no storage: only this tab's own focus suppresses */ }
}
/** Some tab on this device has the session open and focused (it acknowledges; nobody tells it). */
export function watched(sessionId: string, now = Date.now()): boolean {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(WATCHING_PREFIX)) continue
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (!value || typeof value !== 'object') continue
      const { sessionId: watching, at } = value as { sessionId?: unknown; at?: unknown }
      if (watching === sessionId && typeof at === 'number' && now - at <= WATCHING_STALE_MS) return true
    }
  } catch { /* unreadable: not watched */ }
  return false
}

const FOCUSED_PREFIX = 'bakin-terminal-focused:'
/**
 * Whether a Bakin tab on this device has focus (every page runs the attention
 * provider, which beats this). The host sends an OS notification only from
 * an unfocused tab and checks only that tab: a focused Bakin tab elsewhere
 * already has the toast, so no tab sends one then.
 */
export function setFocused(tab: string, focused: boolean, now = Date.now()): void {
  try {
    if (focused) localStorage.setItem(FOCUSED_PREFIX + tab, String(now))
    else localStorage.removeItem(FOCUSED_PREFIX + tab)
  } catch { /* no storage: only this tab's own focus counts */ }
}
export function otherTabFocused(tab: string, now = Date.now()): boolean {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(FOCUSED_PREFIX) || key === FOCUSED_PREFIX + tab) continue
      if (now - Number(localStorage.getItem(key)) <= WATCHING_STALE_MS) return true
    }
  } catch { /* unreadable: none */ }
  return false
}

const CLAIM_DB = 'bakin-terminal-announced'
const CLAIM_STORE = 'claims'
const CLAIM_TTL_MS = 10 * 60_000
/**
 * True for one tab per key (spec: notifications deduplicated across tabs).
 * The decision is one IndexedDB read-write transaction — the browser runs
 * those one at a time across tabs, on plain-HTTP origins too (Web Locks exist
 * only on secure ones, and Bakin is often reached over HTTP on a tailnet).
 * Claims older than ten minutes are dropped in it. Without IndexedDB (a
 * private window, a test DOM), every tab tells its own — never none.
 */
export async function claimOnce(key: string, now = Date.now(), factory: IDBFactory | undefined = globalThis.indexedDB): Promise<boolean> {
  if (!factory) return true
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(CLAIM_DB, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore(CLAIM_STORE) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(CLAIM_STORE, 'readwrite')
        const store = transaction.objectStore(CLAIM_STORE)
        let won = false
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const entry = cursor.result
          if (entry) {
            if (!(now - Number(entry.value) <= CLAIM_TTL_MS)) entry.delete()
            entry.continue()
            return
          }
          const held = store.get(key)
          held.onsuccess = () => {
            const at = held.result as unknown
            if (typeof at === 'number' && now - at <= CLAIM_TTL_MS) return
            store.put(now, key)
            won = true
          }
        }
        transaction.oncomplete = () => resolve(won)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { db.close() }
  } catch { return true }
}
