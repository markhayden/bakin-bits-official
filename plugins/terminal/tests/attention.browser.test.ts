import { expect, test } from 'bun:test'
import { TerminalService } from '../lib/service'
import { launchChromium } from './browser'

// Spec item 5 / plan T22 against the preview: a program's hook sets the pane's
// state in real tmux; the session's header shows it at once, and the open,
// focused session acknowledges it. TERMINAL_PREVIEW_TMUX and
// TERMINAL_PREVIEW_ROOT are the tmux and workingDirectory the preview printed.
const previewTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip
const endpoint = (path: string) => new URL(`/api/plugins/terminal${path}`, process.env.TERMINAL_PREVIEW_URL!).href

previewTest('a needs-you state shows in the header and the focused session acknowledges it; clearing removes the chip', async () => {
  const browser = await launchChromium()
  const client = 'attention-browser-test-01'
  const headers = { 'X-Bakin-Terminal-Client': client }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const { id } = await (await page.request.post(endpoint('/sessions'), { headers, data: { title: 'Attention', cwd: '/tmp' } })).json() as { id: string }
    const tmux = process.env.TERMINAL_PREVIEW_TMUX!
    const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
    // What the helper a hook runs does (lib/attention.ts).
    const set = (state: string) => Bun.spawnSync([tmux, '-S', socket, 'set-option', '-p', '-t', id, '@bakin_attention', state])
    await page.goto(new URL(`/terminal/${id}`, process.env.TERMINAL_PREVIEW_URL!).href)
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    const chip = page.locator('[data-slot="workspace-page-compact-header"], [data-slot="workspace-page-header"]').filter({ visible: true }).locator('[data-attention]').first()
    set('needs-you')
    await chip.waitFor({ timeout: 10_000 })
    expect(await chip.getAttribute('data-attention')).toBe('needs-you')
    expect(await chip.textContent()).toBe('Needs you')
    // Seen here: acknowledged on the server (the badge and every other screen follow).
    const attention = async () => ((await (await page.request.get(endpoint('/attention'), { headers })).json()) as { sessions: Array<{ id: string; attention?: { state: string; acknowledgedAt?: number } }> }).sessions.find((session) => session.id === id)?.attention
    expect(await page.evaluate(() => document.hasFocus())).toBe(true)
    for (let tries = 0; tries < 50 && (await attention())?.acknowledgedAt === undefined; tries++) await Bun.sleep(100)
    expect(await attention()).toMatchObject({ state: 'needs-you', acknowledgedAt: expect.any(Number) })
    // A new state is unacknowledged until seen, then seen again.
    set('turn-finished')
    await page.waitForFunction(() => document.querySelector('[data-attention]')?.getAttribute('data-attention') === 'turn-finished', null, { timeout: 10_000 })
    expect(await chip.textContent()).toBe('Your turn')
    for (let tries = 0; tries < 50 && (await attention())?.acknowledgedAt === undefined; tries++) await Bun.sleep(100)
    expect(await attention()).toMatchObject({ state: 'turn-finished', acknowledgedAt: expect.any(Number) })
    set('')
    await page.waitForFunction(() => !document.querySelector('[data-attention]'), null, { timeout: 10_000 })
    const taken = await (await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'take' } })).json() as { generation: number }
    await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'terminate', generation: taken.generation } })
  } finally {
    await browser.close()
  }
}, 60_000)

previewTest('two tabs: the session watched in one is told in neither; otherwise one OS notification between them and a toast in each visible tab', async () => {
  const browser = await launchChromium()
  const client = 'attention-browser-test-02'
  const headers = { 'X-Bakin-Terminal-Client': client }
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } })
    // Each tab: notifications on and granted (the host's own check), recorded instead of shown; focus and
    // visibility as the test sets them (headless pages all report focus).
    await context.addInitScript(() => {
      const state = window as unknown as { __focused: boolean; __hidden: boolean; __notes: string[] }
      state.__focused = false; state.__hidden = false; state.__notes = []
      localStorage.setItem('bakin-notifications-enabled', 'true')
      class Recorded { static permission = 'granted'; onclick: unknown = null; constructor(title: string) { state.__notes.push(title) } close() {} }
      Object.defineProperty(window, 'Notification', { value: Recorded, configurable: true })
      document.hasFocus = () => state.__focused
      Object.defineProperty(document, 'visibilityState', { get: () => state.__hidden ? 'hidden' : 'visible', configurable: true })
    })
    const a = await context.newPage()
    const b = await context.newPage()
    const { id } = await (await a.request.post(endpoint('/sessions'), { headers, data: { title: 'Two tabs', cwd: '/tmp' } })).json() as { id: string }
    const tmux = process.env.TERMINAL_PREVIEW_TMUX!
    const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
    const set = (state: string) => Bun.spawnSync([tmux, '-S', socket, 'set-option', '-p', '-t', id, '@bakin_attention', state])
    const attention = async () => ((await (await a.request.get(endpoint('/attention'), { headers })).json()) as { sessions: Array<{ id: string; attention?: { state: string; acknowledgedAt?: number } }> }).sessions.find((session) => session.id === id)?.attention
    const notes = async () => [...await a.evaluate(() => (window as unknown as { __notes: string[] }).__notes), ...await b.evaluate(() => (window as unknown as { __notes: string[] }).__notes)]
    const toasts = (page: typeof a) => page.evaluate(() => (window as unknown as { __toasts(): string[] }).__toasts().length)
    const focus = (page: typeof a, focused: boolean) => page.evaluate((value) => { (window as unknown as { __focused: boolean }).__focused = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')) }, focused)
    // A has the session open and focused; B is on the list, hidden.
    await a.goto(new URL(`/terminal/${id}`, process.env.TERMINAL_PREVIEW_URL!).href)
    await a.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    await b.goto(new URL('/terminal', process.env.TERMINAL_PREVIEW_URL!).href)
    await b.evaluate(() => { (window as unknown as { __hidden: boolean }).__hidden = true })
    await focus(a, true)
    await Bun.sleep(1500)
    set('needs-you')
    for (let tries = 0; tries < 50 && (await attention())?.acknowledgedAt === undefined; tries++) await Bun.sleep(100)
    expect(await attention()).toMatchObject({ state: 'needs-you', acknowledgedAt: expect.any(Number) })
    await Bun.sleep(1500)
    expect(await notes()).toEqual([])
    expect(await toasts(a) + await toasts(b)).toBe(0)
    // Nobody watches it now (A blurred, B shown): told once by OS notification, a toast in each visible tab.
    await focus(a, false)
    await b.evaluate(() => { (window as unknown as { __hidden: boolean }).__hidden = false })
    set('turn-finished')
    for (let tries = 0; tries < 50 && (await notes()).length === 0; tries++) await Bun.sleep(100)
    await Bun.sleep(1500)
    expect(await notes()).toEqual(['Your turn in Two tabs'])
    expect([await toasts(a), await toasts(b)]).toEqual([1, 1])
    expect((await attention())?.acknowledgedAt).toBeUndefined()
    const taken = await (await a.request.post(endpoint('/session'), { headers, data: { id, operation: 'take' } })).json() as { generation: number }
    await a.request.post(endpoint('/session'), { headers, data: { id, operation: 'terminate', generation: taken.generation } })
  } finally {
    await browser.close()
  }
}, 90_000)

previewTest('the cross-tab claim is atomic (one IndexedDB transaction): many racers in three tabs, one winner per key; an expired claim is won again', async () => {
  const browser = await launchChromium()
  try {
    const context = await browser.newContext()
    const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()])
    await Promise.all(pages.map((page) => page.goto(new URL('/terminal', process.env.TERMINAL_PREVIEW_URL!).href)))
    await Promise.all(pages.map((page) => page.waitForFunction(() => typeof (window as unknown as { __claimOnce?: unknown }).__claimOnce === 'function')))
    const race = (key: string, now: number) => Promise.all(pages.flatMap((page) => [0, 1, 2, 3].map(() =>
      page.evaluate(({ key, now }) => (window as unknown as { __claimOnce(key: string, now: number): Promise<boolean> }).__claimOnce(key, now), { key, now }))))
    for (const key of ['one', 'two', 'three']) expect((await race(key, 1_000)).filter(Boolean)).toHaveLength(1)
    // Within ten minutes it stays claimed; after, one tab wins it again.
    expect((await race('one', 1_000 + 60_000)).filter(Boolean)).toHaveLength(0)
    expect((await race('one', 1_000 + 10 * 60_000 + 1)).filter(Boolean)).toHaveLength(1)
  } finally {
    await browser.close()
  }
}, 60_000)
