import './setup-dom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { emitPluginEvent } from '@makinbakin/sdk/hooks'
import { getNavBadge } from '@makinbakin/sdk'
import { announcements, attentionBadge, attentionChip, claimOnce, otherTabFocused, setFocused, setWatching, visibleSessionId, wantsYou, watched } from '../components/attention'
import { TerminalAttentionProvider } from '../components/attention-provider'
import { ATTENTION_EVENT, type AttentionSummary, type Session } from '../lib/contracts'

/** The page's URL (happy-dom starts at about:blank, where history cannot set a path). */
const at = (path: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://localhost${path}`)
const running = (attention?: Session['attention']) => ({ state: 'running' as const, attention })
const summary = (id: string, attention?: Session['attention'], extra: Partial<AttentionSummary> = {}): AttentionSummary => ({ id, title: `Session ${id}`, program: 'claude', state: 'running', attention, ...extra })
const needsYou = (occurrence: number, acknowledgedAt?: number): Session['attention'] => ({ state: 'needs-you', since: occurrence, occurrence, ...(acknowledgedAt ? { acknowledgedAt } : {}) })

describe('rules', () => {
  test('chips: needs you, your turn, working; none when unknown or ended; outlined once acknowledged', () => {
    expect(attentionChip(running(needsYou(1)))).toMatchObject({ label: 'Needs you', tone: 'attention', acknowledged: false })
    expect(attentionChip(running({ state: 'turn-finished', since: 1, occurrence: 1, acknowledgedAt: 2 }))).toMatchObject({ label: 'Your turn', tone: 'success', acknowledged: true })
    expect(attentionChip(running({ state: 'working', since: 1, occurrence: 1 }))).toMatchObject({ label: 'Working' })
    expect(attentionChip(running())).toBeUndefined()
    expect(attentionChip({ state: 'exited', attention: needsYou(1) })).toBeUndefined()
  })
  test('the badge counts unacknowledged needs-you and your-turn sessions; attention tone while any needs you', () => {
    expect(attentionBadge([running({ state: 'working', since: 1, occurrence: 1 }), running()])).toBeNull()
    expect(attentionBadge([running({ state: 'turn-finished', since: 1, occurrence: 1 })])).toEqual({ count: 1, tone: 'success' })
    expect(attentionBadge([running({ state: 'turn-finished', since: 1, occurrence: 1 }), running(needsYou(1)), running(needsYou(2, 3))])).toEqual({ count: 2, tone: 'attention' })
    expect(wantsYou({ state: 'completed', attention: needsYou(1) })).toBe(false)
  })
  test('the open session comes from the path', () => {
    expect(visibleSessionId('/terminal/terminal-abc')).toBe('terminal-abc')
    expect(visibleSessionId('/terminal')).toBeUndefined()
    expect(visibleSessionId('/tasks')).toBeUndefined()
  })
  test('announcements: the first read is the baseline; then each new unacknowledged occurrence and each new bell', () => {
    expect(announcements(undefined, [summary('a', needsYou(1))])).toEqual([])
    const before = new Map([['a', summary('a', needsYou(1))]])
    // Same occurrence: nothing; a newer one: told; acknowledged or working: not told.
    expect(announcements(before, [summary('a', needsYou(1))])).toEqual([])
    expect(announcements(before, [summary('a', { state: 'turn-finished', since: 2, occurrence: 2 }, { program: 'codex' })])).toEqual([
      { sessionId: 'a', key: 'attention:a:2', title: 'Your turn in Session a', body: 'Codex finished its turn.', href: '/terminal/a' },
    ])
    expect(announcements(before, [summary('a', needsYou(2, 5))])).toEqual([])
    expect(announcements(before, [summary('a', { state: 'working', since: 2, occurrence: 2 })])).toEqual([])
    // A session first seen after the baseline that needs you is told; an ended one never.
    expect(announcements(before, [summary('a', needsYou(1)), summary('b', needsYou(1))]).map((item) => item.key)).toEqual(['attention:b:1'])
    expect(announcements(before, [summary('a', needsYou(3), { state: 'exited' })])).toEqual([])
    // Bells: a new bellAt.
    expect(announcements(new Map([['a', summary('a', undefined, { bellAt: 10 })]]), [summary('a', undefined, { bellAt: 10 })])).toEqual([])
    expect(announcements(new Map([['a', summary('a', undefined, { bellAt: 10 })]]), [summary('a', undefined, { bellAt: 50, program: 'shell' })])).toEqual([
      { sessionId: 'a', key: 'bell:a:50', title: 'Session a rang', body: 'The terminal rang its bell.', href: '/terminal/a' },
    ])
  })
})

describe('across tabs', () => {
  beforeEach(() => localStorage.clear())
  test('without IndexedDB (a private window, this test DOM) every tab tells its own — never none', async () => {
    expect(globalThis.indexedDB).toBeUndefined()
    expect(await claimOnce('a')).toBe(true)
    expect(await claimOnce('a')).toBe(true)
  })
  test('focus: another Bakin tab focused counts; this tab, or one that went quiet, does not', () => {
    setFocused('tab-1', true, 1000)
    expect(otherTabFocused('tab-2', 1000)).toBe(true)
    expect(otherTabFocused('tab-1', 1000)).toBe(false)
    expect(otherTabFocused('tab-2', 1000 + 15_001)).toBe(false)
    setFocused('tab-1', false, 2000)
    expect(otherTabFocused('tab-2', 2000)).toBe(false)
  })
  test('watching: a tab says which session it has focused; it stops saying so, or goes quiet, and the session is not watched', () => {
    setWatching('tab-1', 's1', 1000)
    expect(watched('s1', 1000)).toBe(true)
    expect(watched('s2', 1000)).toBe(false)
    // One entry per tab: it moved to s2.
    setWatching('tab-1', 's2', 2000)
    expect(watched('s1', 2000)).toBe(false)
    setWatching('tab-2', 's1', 2000)
    expect(watched('s1', 2000)).toBe(true)
    setWatching('tab-2', undefined, 3000)
    expect(watched('s1', 3000)).toBe(false)
    // A tab that went away without saying (closed, crashed) is forgotten after three beats.
    expect(watched('s2', 2000 + 15_000)).toBe(true)
    expect(watched('s2', 2000 + 15_001)).toBe(false)
    localStorage.setItem('bakin-terminal-watching:broken', 'null')
    localStorage.setItem('bakin-terminal-watching:junk', '{not json')
    expect(watched('s1')).toBe(false)
  })
})

describe('provider', () => {
  const toasts: unknown[] = []
  const notifications: unknown[][] = []
  /** Each /attention read waits on its own answer, so a test decides the order they land in. */
  let answers: Array<(sessions: AttentionSummary[]) => void> = []
  beforeEach(() => {
    localStorage.clear()
    toasts.length = 0; notifications.length = 0
    answers = []
    globalThis.fetch = (async (url: string) => {
      if (!String(url).endsWith('/attention')) return Response.json({ error: 'unexpected' }, { status: 404 })
      const sessions = await new Promise<AttentionSummary[]>((resolve) => answers.push(resolve))
      return Response.json({ sessions })
    }) as typeof fetch
    document.hasFocus = () => false
    at('/tasks')
  })
  afterEach(cleanup)
  // Recorded instead of shown (this runs against the test stub and, in conformance, the real SDK).
  const delivery = { toast: (message: unknown) => { toasts.push(message) }, notify: (...args: unknown[]) => { notifications.push(args) } }
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
  /** Answer every read waiting, oldest first. */
  const answerAll = async (sessions: AttentionSummary[]) => {
    await settle()
    for (const answer of answers.splice(0)) answer(sessions)
    await settle()
  }
  const changed = (sessionId = 's1') => act(async () => { emitPluginEvent({ event: ATTENTION_EVENT, sessionId }) })

  test('the badge follows the newest read; an older answer landing last never brings back what was acknowledged', async () => {
    render(<TerminalAttentionProvider delivery={delivery} />)
    await answerAll([summary('s1', needsYou(1))])
    expect(getNavBadge('terminal')).toEqual({ count: 1, tone: 'attention' })
    // Two reads in flight; the newer (acknowledged) lands first, the older last.
    await changed(); await changed()
    await settle()
    const [older, newer] = answers.splice(0)
    newer([summary('s1', needsYou(1, 9))])
    await settle()
    older([summary('s1', needsYou(1))])
    await settle()
    expect(getNavBadge('terminal') ?? null).toBeNull()
  })
  test('a change is told in each visible tab by a toast, and by an OS notification only while no other Bakin tab has focus', async () => {
    render(<TerminalAttentionProvider delivery={delivery} />)
    await answerAll([summary('s1')])
    await changed()
    await answerAll([summary('s1', needsYou(1))])
    expect(toasts).toHaveLength(1)
    expect(notifications).toEqual([['Session s1 needs you', 'Claude Code is waiting for your answer.', '/terminal/s1']])
    // Another Bakin tab has focus: its toast is there, so no OS notification from here.
    setFocused('other-tab', true)
    await changed()
    await answerAll([summary('s1', { state: 'turn-finished', since: 2, occurrence: 2 })])
    expect(toasts).toHaveLength(2)
    expect(notifications).toHaveLength(1)
  })
  test('a change missed while disconnected is told on the reconnect read', async () => {
    render(<TerminalAttentionProvider delivery={delivery} />)
    await answerAll([summary('s1')])
    await act(async () => { emitPluginEvent({ event: 'bakin.reconcile' }) })
    await answerAll([summary('s1', needsYou(4), { bellAt: 77 })])
    expect(notifications.map((args) => args[0])).toEqual(['Session s1 needs you', 'Session s1 rang'])
  })
  test('the session open and focused in this tab, or watched by another tab on this device: nothing told', async () => {
    at('/terminal/s1')
    document.hasFocus = () => true
    render(<TerminalAttentionProvider delivery={delivery} />)
    await answerAll([summary('s1'), summary('s2')])
    await changed()
    await answerAll([summary('s1', needsYou(1)), summary('s2')])
    expect(toasts).toHaveLength(0)
    // Another tab watches s2; this one is elsewhere and unfocused.
    at('/tasks')
    document.hasFocus = () => false
    setWatching('other-tab', 's2')
    await changed('s2')
    await answerAll([summary('s1', needsYou(1)), summary('s2', needsYou(1))])
    expect(toasts).toHaveLength(0)
    expect(notifications).toHaveLength(0)
  })
})
