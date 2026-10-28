import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalService } from '../lib/service'
import { launchChromium } from './browser'

// Spec D13 / plan T33: the raw path against the preview with it forced on
// (TERMINAL_PREVIEW_RAW=1 for both the preview and this run). The overload
// test reads the pane from tmux: TERMINAL_PREVIEW_TMUX and TERMINAL_PREVIEW_ROOT
// are the tmux and workingDirectory the preview printed.
const rawTest = process.env.TERMINAL_PREVIEW_URL && process.env.TERMINAL_PREVIEW_RAW === '1' ? test : test.skip

type Browser = Awaited<ReturnType<typeof launchChromium>>
type Page = Awaited<ReturnType<Browser['newPage']>>

const base = () => process.env.TERMINAL_PREVIEW_URL!
const endpoint = (path: string) => new URL(`/api/plugins/terminal${path}`, base()).href
const viewport = { width: 1100, height: 760 }

async function createSession(page: Page, client: string): Promise<{ id: string }> {
  const created = await page.request.post(endpoint('/sessions'), { headers: { 'X-Bakin-Terminal-Client': client }, data: { title: 'Raw path', cwd: '/tmp' } })
  return created.json() as Promise<{ id: string }>
}
async function endSession(page: Page, client: string, id: string): Promise<void> {
  const headers = { 'X-Bakin-Terminal-Client': client }
  const taken = await (await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'take' } })).json() as { generation: number }
  await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'terminate', generation: taken.generation } })
}
/** Open the session and wait until its first replay is applied (the display is live). */
async function open(page: Page, id: string): Promise<void> {
  await page.goto(new URL(`/terminal/${id}`, base()).href)
  await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
}
async function typeLine(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}
/**
 * The visible rows, as screen readers get them, once xterm's accessibility
 * refresh (throttled to one a second) has caught up with the screen.
 */
async function rows(page: Page): Promise<string[]> {
  await page.waitForTimeout(1_100)
  return page.evaluate(() => [...document.querySelectorAll('.xterm-accessibility-tree > div')].map((row) => row.textContent ?? ''))
}
const waitForRow = (page: Page, pattern: string, timeout = 10_000) =>
  page.waitForFunction((source) => [...document.querySelectorAll('.xterm-accessibility-tree > div')].some((row) => new RegExp(source).test(row.textContent ?? '')), pattern, { timeout })
const hasRow = (page: Page, pattern: string) =>
  page.evaluate((source) => [...document.querySelectorAll('.xterm-accessibility-tree > div')].some((row) => new RegExp(source).test(row.textContent ?? '')), pattern)

rawTest('a viewer that joins during output, mid-escape and in the alternate screen sees what the first one sees', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-join-test-01'
  const first = await browser.newPage({ viewport })
  const { id } = await createSession(first, client)
  // Each producer holds its state until the test lets it go (a file appears).
  const gates = mkdtempSync(join(tmpdir(), 'bakin-raw-join-'))
  const release = (name: string) => writeFileSync(join(gates, name), '')
  const hold = (name: string) => `while [ ! -f ${join(gates, name)} ]; do sleep 0.02; done`
  try {
    await open(first, id)
    // During output: numbered lines keep coming while the second viewer joins.
    await typeLine(first, `clear; i=0; while [ ! -f ${join(gates, 'output')} ]; do i=$((i+1)); echo "line $i"; sleep 0.01; done; echo output-done`)
    await waitForRow(first, '^line \\d+$')
    const second = await browser.newPage({ viewport })
    await open(second, id)
    expect(await hasRow(first, '^output-done$')).toBe(false)
    release('output')
    await waitForRow(first, '^output-done$')
    await waitForRow(second, '^output-done$')
    expect(await rows(second)).toEqual(await rows(first))
    // Mid-escape: the third viewer joins while the CSI is half written.
    await typeLine(first, `clear; printf 'before\\033['; ${hold('escape')}; printf '2J\\033[Hafter-escape\\n'`)
    await waitForRow(first, '^before')
    const third = await browser.newPage({ viewport })
    await open(third, id)
    expect(await hasRow(third, 'after-escape')).toBe(false)
    release('escape')
    await waitForRow(third, '^after-escape$')
    expect((await rows(third)).join('\n')).not.toContain('[2J')
    expect(await rows(third)).toEqual(await rows(first))
    // The alternate screen (its text spelled with an escape, so the typed command never matches it).
    await typeLine(first, `clear; echo normal-screen; printf '\\033[?1049h\\033[H\\101LT-SCREEN'; ${hold('alternate')}; printf '\\033[?1049l'`)
    await waitForRow(first, '^ALT-SCREEN')
    const fourth = await browser.newPage({ viewport })
    await open(fourth, id)
    await waitForRow(fourth, '^ALT-SCREEN')
    expect(await hasRow(fourth, '^normal-screen$')).toBe(false)
    release('alternate')
    await waitForRow(fourth, '^normal-screen$')
    expect(await rows(fourth)).toEqual(await rows(first))
  } finally {
    await endSession(first, client, id)
    await browser.close()
    rmSync(gates, { recursive: true, force: true })
  }
}, 120_000)

rawTest('a join carries more than 2,000 retained rows of scrollback', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-scroll-test-01'
  const first = await browser.newPage({ viewport })
  const { id } = await createSession(first, client)
  try {
    await open(first, id)
    await typeLine(first, 'clear; seq 1 3000; echo history-done')
    await waitForRow(first, '^history-done$')
    const joined = await browser.newPage({ viewport })
    await open(joined, id)
    await waitForRow(joined, '^history-done$')
    // Scrolled back with xterm's own keys (a page at a time, past the 3,000 rows), the oldest row is the first.
    await joined.locator('.xterm-helper-textarea').focus()
    for (let i = 0; i < 70; i++) await joined.keyboard.press('Shift+PageUp')
    expect((await rows(joined))[0]).toBe('1')
  } finally {
    await endSession(first, client, id)
    await browser.close()
  }
}, 120_000)

rawTest('keystroke to visible echo is under 50 ms at the 95th percentile in normal use', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-echo-test-01'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, 'clear; cat')
    // Measured in the page, from the key event to the echoed character in the
    // screen-reader rows (refreshed on render; one a second at most, so the
    // keys are spaced past both that refresh and its trailing one). A key whose
    // echo has not come by the next key counts as a miss, never as dropped.
    await page.evaluate(() => {
      const w = window as unknown as { pressed: number; want: string; seen: number; samples: number[]; misses: number }
      const tree = document.querySelector('.xterm-accessibility-tree')!
      w.samples = []
      w.misses = 0
      document.addEventListener('keydown', (event) => {
        if (event.key.length !== 1) return
        if (w.pressed) w.misses++
        w.pressed = performance.now()
        w.want = event.key
        w.seen = (tree.textContent ?? '').split(event.key).length
      }, true)
      new MutationObserver(() => {
        if (w.pressed && (tree.textContent ?? '').split(w.want).length > w.seen) { w.samples.push(performance.now() - w.pressed); w.pressed = 0 }
      }).observe(tree, { subtree: true, childList: true, characterData: true })
    })
    await page.locator('.xterm-helper-textarea').focus()
    const keys = 32
    for (let i = 0; i < keys; i++) { await page.waitForTimeout(2_100); await page.keyboard.type(String.fromCharCode(97 + (i % 26))) }
    await page.waitForTimeout(2_100)
    const { samples: all, misses, pending } = await page.evaluate(() => {
      const w = window as unknown as { samples: number[]; misses: number; pressed: number }
      return { samples: w.samples, misses: w.misses, pending: w.pressed ? 1 : 0 }
    })
    // Every key echoed.
    expect(misses + pending).toBe(0)
    expect(all).toHaveLength(keys)
    // The first two warm the path up.
    const samples = all.slice(2).sort((a, b) => a - b)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!
    console.log(`echo p50 ${samples[Math.floor(samples.length / 2)]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (${samples.map((n) => n.toFixed(0)).join(' ')})`)
    expect(p95).toBeLessThan(50)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 150_000)

rawTest('overload (D13 bounded load): 30 s of flood with a stalled viewer — eviction, memory, Ctrl-C, freshness and reconnect', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-flood-test-01'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  const pane = (format: string) => Bun.spawnSync([tmux, '-S', socket, 'display', '-p', '-t', id, format]).stdout.toString().trim()
  // The preview's heap after a collection (the spec's figure) and its resident memory (logged).
  const memory = async () => (await page.request.get(new URL('/__memory', base()).href)).json() as Promise<{ heap: number; rss: number; estimate: { sessions: number; viewers: number } }>
  // A real viewer page whose acknowledgements are held back: its window fills.
  const stalledPage = await browser.newPage({ viewport })
  const stall = { on: true, connections: 0, closes: [] as number[] }
  await stalledPage.routeWebSocket('**/api/plugins/terminal/socket**', (ws) => {
    stall.connections++
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      if (stall.on && typeof message === 'string' && JSON.parse(message).type === 'retired') return
      server.send(message)
    })
    server.onClose((code) => { stall.closes.push(code ?? 0); void ws.close({ code }) })
  })
  let reloaded = false
  page.on('websocket', (ws) => ws.on('framereceived', (frame) => {
    if (typeof frame.payload === 'string') {
      const message = JSON.parse(frame.payload) as { type: string; fidelity?: { history?: string } }
      if (message.type === 'rebase' && message.fidelity?.history === 'reloaded') reloaded = true
    }
  }))
  // How fresh the healthy viewer's screen is: the newest stamp in its rendered rows (as screen readers
  // get them: refreshed on render, a second apart at most, and from the whole picture when one is shown).
  const shownStamp = () => page.evaluate(() => {
    const stamps = [...document.querySelectorAll('.xterm-accessibility-tree > div')].map((row) => /^t (\d{13}) /.exec(row.textContent ?? '')?.[1]).filter(Boolean).map(Number)
    return stamps.length ? Math.max(...stamps) : 0
  })
  try {
    await open(page, id)
    await open(stalledPage, id)
    await page.waitForTimeout(1_000)
    const before = await memory()
    const peak = { ...before }
    let peakEstimate = before.estimate
    const sample = async () => {
      const now = await memory()
      if (now.heap > peak.heap) peakEstimate = now.estimate
      peak.heap = Math.max(peak.heap, now.heap)
      peak.rss = Math.max(peak.rss, now.rss)
    }
    // An unbounded producer that stamps each line with the wall clock (ms).
    await typeLine(page, `perl -MTime::HiRes=time -e '$| = 1; while (1) { printf "t %d %s\\n", time * 1000, "x" x 200 }'`)
    const floodStarted = Date.now()
    while (pane('#{pane_current_command}') !== 'perl' && Date.now() - floodStarted < 5_000) await Bun.sleep(20)
    // How fresh the healthy screen is, from the first second of the flood; a sample with no stamp shown is a miss.
    const lags: number[] = []
    let misses = 0
    const observe = async () => { const shown = await shownStamp(); if (shown) lags.push(Date.now() - shown); else misses++ }
    await Bun.sleep(1_000)
    // The stalled viewer is evicted within the stall window (10 s) of filling, which is at once.
    for (let last = 0; !stall.closes.length && Date.now() - floodStarted < 20_000; await Bun.sleep(100)) {
      await sample()
      if (Date.now() - last >= 1_000) { last = Date.now(); await observe() }
    }
    const evicted = Date.now() - floodStarted
    expect(stall.closes[0]).toBe(4000)
    expect(evicted).toBeLessThan(11_000)
    // Sustain the flood for 30 s, reading the memory and how fresh the healthy viewer is. The heap swings
    // with each rebuild cycle (queues filling and draining, ~10 MiB): growth is judged on the median of
    // each window, the second ten seconds against the third, once the scrollback has filled.
    const windows: [number[], number[]] = [[], []]
    while (Date.now() - floodStarted < 30_000) {
      const now = await memory()
      peak.heap = Math.max(peak.heap, now.heap)
      peak.rss = Math.max(peak.rss, now.rss)
      const at = Date.now() - floodStarted
      if (at >= 10_000) windows[at < 20_000 ? 0 : 1].push(now.heap)
      await observe()
      await Bun.sleep(1_000)
    }
    // Still flooding at the end: the Ctrl-C below is what stops it.
    expect(pane('#{pane_current_command}')).toBe('perl')
    const interrupted = Date.now()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+C')
    while (pane('#{pane_current_command}') === 'perl' && Date.now() - interrupted < 5_000) await Bun.sleep(10)
    const stopped = Date.now() - interrupted
    lags.sort((a, b) => a - b)
    const lag = lags[Math.ceil(lags.length * 0.95) - 1] ?? Infinity
    expect(misses).toBe(0)
    const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(1)
    console.log(`evicted ${evicted} ms; heap growth ${mib(peak.heap - before.heap)} MiB (resident ${mib(peak.rss - before.rss)} MiB; estimated at the peak: sessions ${mib(peakEstimate.sessions)} MiB, viewers ${mib(peakEstimate.viewers)} MiB); display lag p95 ${lag} ms; Ctrl-C stopped the flood in ${stopped} ms`)
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    const [second, third] = [median(windows[0]), median(windows[1])]
    console.log(`heap medians 10–20 s ${mib(second - before.heap)} MiB, 20–30 s ${mib(third - before.heap)} MiB over the start; freshness samples ${lags.length} (${lags.map((n) => n.toFixed(0)).join(' ')})`)
    expect(stopped).toBeLessThan(1_000)
    // Bounded: a flat heap once the session's scrollback is full, and the whole within the
    // session's peak budget (T32d, 96 MB: replica, bridge Screen, queues and joins).
    expect(third - second).toBeLessThan(8 * 2 ** 20)
    expect(peak.heap - before.heap).toBeLessThan(96 * 1e6)
    // About a second of lag is allowed under overload.
    expect(lag).toBeLessThan(1_500)
    // The evicted viewer reconnects by itself; once it acknowledges again it converges with the healthy one.
    stall.on = false
    await typeLine(page, 'echo flood-stopped')
    await waitForRow(page, '^flood-stopped$')
    // Quiet: the history the overload's screen-only pictures left out comes back from tmux, as a rebase that says so.
    for (const start = Date.now(); !reloaded; await page.waitForTimeout(100)) {
      if (Date.now() - start > 15_000) throw new Error('history not restored')
    }
    await waitForRow(stalledPage, '^flood-stopped$', 20_000)
    expect(stall.connections).toBeGreaterThan(1)
    expect(await rows(stalledPage)).toEqual(await rows(page))
  } finally {
    Bun.spawnSync([tmux, '-S', socket, 'send-keys', '-t', id, 'C-c'])
    await endSession(page, client, id)
    await browser.close()
  }
}, 150_000)
