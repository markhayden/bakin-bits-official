import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalService } from '../lib/service'
import { launchChromium, viewerSocket } from './browser'

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

rawTest("a width change (plan T34a): the viewer installs tmux's geometry and shows what tmux shows, with no rebuild", async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-width-test-01'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  // (The target before the rest: tmux stops reading options at the first argument.)
  const pane = (command: string, ...args: string[]) => Bun.spawnSync([tmux, '-S', socket, command, '-t', id, ...args]).stdout.toString()
  const gates = mkdtempSync(join(tmpdir(), 'bakin-raw-width-'))
  const frames: string[] = []
  page.on('websocket', (ws) => ws.on('framereceived', (frame) => {
    if (typeof frame.payload === 'string') frames.push((JSON.parse(frame.payload) as { type: string }).type)
  }))
  const trimmed = (lines: string[]) => { const out = lines.map((line) => line.trimEnd()); while (out.length && out.at(-1) === '') out.pop(); return out }
  try {
    await open(page, id)
    const width = Number(pane('display', '-p', '#{pane_width}').trim())
    expect(width).toBeGreaterThan(60)
    // Lines that wrap, then the cursor left inside a line wrapped past the width: tmux reflows the cursor's
    // line on a resize and xterm does not (spike 2's lost character). A program holds it there, not the shell.
    await typeLine(page, `clear; for i in 1 2 3; do printf 'row%s-%0${width + 40}d\\n' $i 0; done; printf 'cursor-%0${width + 20}d' 0; while [ ! -f ${join(gates, 'go')} ]; do sleep 0.05; done; echo; echo width-done`)
    await waitForRow(page, "^cursor-0+$")
    // tmux narrows the window (any size authority ends here): it reflows, and the viewer follows its geometry.
    pane('resize-window', '-x', String(width - 30))
    for (const start = Date.now(); !frames.includes('geometry'); await Bun.sleep(50)) {
      if (Date.now() - start > 10_000) throw new Error('no geometry frame')
    }
    expect(trimmed(await rows(page))).toEqual(trimmed(pane('capture-pane', '-p').split('\n')))
    expect(frames).not.toContain('rebuilding')
    expect(frames.filter((type) => type === 'rebase')).toEqual([])
    // Output after it lands where tmux has it.
    writeFileSync(join(gates, 'go'), '')
    await waitForRow(page, '^width-done$')
    expect(trimmed(await rows(page))).toEqual(trimmed(pane('capture-pane', '-p').split('\n')))
  } finally {
    await endSession(page, client, id)
    await browser.close()
    rmSync(gates, { recursive: true, force: true })
  }
}, 60_000)

rawTest('a lost replica (plan T35a): the viewer recovers it from tmux and shows the persistent recovery notice, which a reload keeps', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-recovery-test-01'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  const notice = page.getByRole('status', { name: 'Terminal view recovered with limitations' })
  try {
    await open(page, id)
    await typeLine(page, `printf '%s-%s\\n' before loss`)
    await waitForRow(page, '^before-loss$')
    expect(await notice.count()).toBe(0)
    // Bakin's control client (the replica's source) is lost while the pane and the bridge stay.
    const control = Bun.spawnSync([tmux, '-S', socket, 'list-clients', '-t', id, '-F', '#{client_control_mode} #{client_name}']).stdout.toString()
      .split('\n').filter((line) => line.startsWith('1 ')).map((line) => line.slice(2))
    expect(control).toHaveLength(1)
    Bun.spawnSync([tmux, '-S', socket, 'detach-client', '-t', control[0]!])
    // The viewer reconnects; the join attaches again and rebuilds the replica from tmux.
    await notice.waitFor({ timeout: 20_000 })
    await expect(notice.textContent()).resolves.toContain("Cause: the view's connection to tmux was replaced.")
    await waitForRow(page, '^before-loss$')
    // Input still reaches the program, and its output shows.
    await typeLine(page, `printf '%s-%s\\n' after loss`)
    await waitForRow(page, '^after-loss$')
    // The fidelity is the server's: a reload (a new connection) shows the notice again.
    await page.reload()
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    await notice.waitFor({ timeout: 5_000 })
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

rawTest('an ended session (plan T35b): a terminate while watching turns the view into its saved final picture, and a reload shows it again', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-ended-test-01'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, `printf '%s-%s\\n' final words`)
    await waitForRow(page, '^final-words$')
    // Served from the bundle (a join), not the bridge's legacy output (a sync), which holds the words too.
    const frames: string[] = []
    page.on('websocket', (ws) => ws.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') frames.push((JSON.parse(frame.payload) as { type: string }).type)
    }))
    await endSession(page, client, id)
    // While watching: the live picture closes, the viewer reconnects and joins the ended one.
    for (const start = Date.now(); !frames.includes('join'); await Bun.sleep(50)) if (Date.now() - start > 15_000) throw new Error('no ended join')
    await waitForRow(page, '^final-words$')
    await page.reload()
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    await waitForRow(page, '^final-words$')
    expect(await page.getByText('Ended', { exact: true }).count()).toBeGreaterThan(0)
    expect(frames).toContain('join')
    expect(frames).not.toContain('sync')
  } finally {
    await browser.close()
  }
}, 60_000)

rawTest('an ended session whose output was not saved (plan T35b): the page shows why, with no reconnect loop; another session opens normally after it', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-unsaved-test-01'
  const page = await browser.newPage({ viewport })
  const lost = await createSession(page, client)
  const other = await (await page.request.post(endpoint('/sessions'), { headers: { 'X-Bakin-Terminal-Client': client }, data: { title: 'Opened after', cwd: '/tmp' } })).json() as { id: string }
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  const connections = { count: 0 }
  page.on('websocket', () => { connections.count++ })
  try {
    // No viewer: the replica is lost (its control client detached), then the program ends — nothing to save.
    for (let start = Date.now(); ; await Bun.sleep(50)) {
      const clients = Bun.spawnSync([tmux, '-S', socket, 'list-clients', '-t', lost.id, '-F', '#{client_control_mode} #{client_name}']).stdout.toString()
      const control = clients.split('\n').find((line) => line.startsWith('1 '))
      if (control) { Bun.spawnSync([tmux, '-S', socket, 'detach-client', '-t', control.slice(2)]); break }
      if (Date.now() - start > 10_000) throw new Error('no control client')
    }
    Bun.spawnSync([tmux, '-S', socket, 'kill-pane', '-t', lost.id])
    await page.goto(new URL(`/terminal/${lost.id}`, base()).href)
    await page.getByRole('heading', { name: 'Output not saved' }).waitFor({ timeout: 15_000 })
    const seen = connections.count
    await page.waitForTimeout(1500)
    expect(connections.count).toBe(seen)
    expect(await page.locator('.xterm').count()).toBe(0)
    // In-app navigation (no reload): back to the list, then the other session; the state belongs to that session only.
    await page.evaluate(() => { (window as unknown as { __loaded?: boolean }).__loaded = true })
    await page.getByRole('link', { name: 'Back to terminals' }).click()
    await page.getByText('Opened after', { exact: true }).first().click()
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    expect(await page.evaluate(() => (window as unknown as { __loaded?: boolean }).__loaded)).toBe(true)
    expect(await page.getByRole('heading', { name: 'Output not saved' }).count()).toBe(0)
  } finally {
    await endSession(page, client, other.id).catch(() => undefined)
    await browser.close()
  }
}, 60_000)

rawTest('the safety net (plan T37): a viewer\'s digests match the replica\'s through real output; one made to differ rejoins and agrees again', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-digest-test-01'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  const received: string[] = []
  const reports: string[] = []
  let connections = 0
  let tamper = false
  // Every socket goes through this route; while `tamper` is set, the viewer's next digest is altered on its way out.
  await page.routeWebSocket(/\/socket/, (ws) => {
    connections++
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"type":"digest"')) {
        reports.push(message)
        if (tamper) { tamper = false; server.send(message.replace(/"digest":"[0-9a-f]{8}"/, '"digest":"deadbeef"')); return }
      }
      server.send(message)
    })
    server.onMessage((message) => {
      if (typeof message === 'string') received.push((JSON.parse(message) as { type: string }).type)
      ws.send(message)
    })
  })
  try {
    await open(page, id)
    await typeLine(page, `printf '\\033[1;32mgreen\\033[0m \\033[4:3mwavy\\033[0m\\n'; printf '\\033[?25l'; seq 1 30`)
    await waitForRow(page, '^30$').catch(async (error) => {
      await page.screenshot({ path: join(import.meta.dir, '../test-results/raw-path/digest-fail.png') })
      throw new Error(`${error}; received ${JSON.stringify(received.filter((t) => t !== 'presence'))}, reports ${reports.length}, connections ${connections}, rows ${JSON.stringify(await rows(page))}`)
    })
    // Quiet: a point, answered, and the viewer keeps its connection.
    for (const start = Date.now(); reports.length === 0; await Bun.sleep(100)) if (Date.now() - start > 10_000) throw new Error(`no digest report; received ${JSON.stringify([...new Set(received)])}, points ${received.filter((t) => t === 'digest-point').length}, connections ${connections}`)
    await page.waitForTimeout(500)
    expect(connections).toBe(1)
    // The next report is made to differ: the server rejoins the viewer, and the new picture agrees.
    tamper = true
    await typeLine(page, 'echo after')
    await waitForRow(page, '^after$')
    for (const start = Date.now(); connections < 2; await Bun.sleep(100)) if (Date.now() - start > 15_000) throw new Error('no rejoin after the mismatch')
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    const before = reports.length
    for (const start = Date.now(); reports.length === before; await Bun.sleep(100)) if (Date.now() - start > 10_000) throw new Error('no report after the rejoin')
    await page.waitForTimeout(500)
    expect(connections).toBe(2)
    await waitForRow(page, '^after$')
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

rawTest('two viewers and a terminal app on one session (plan T38a): a program\'s query is answered exactly once, by tmux', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-query-test-01'
  const first = await browser.newPage({ viewport })
  const second = await (await browser.newContext({ viewport })).newPage()
  const { id } = await createSession(first, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const operator = { 'Content-Type': 'application/json', 'X-Bakin-Operator': 'declared', 'X-Bakin-Origin': 'cli' }
  let app: ReturnType<typeof Bun.spawn> | undefined
  try {
    await open(first, id)
    await open(second, id)
    // A terminal app attached the way `bakin terminal attach` does it.
    const prepared = await (await Bun.fetch(new URL('/api/plugins/terminal/cli/attach', base()), { method: 'POST', headers: operator, body: JSON.stringify({ params: { ref: id }, caller: { cwd: '/tmp', cols: 100, rows: 30 } }) })).json() as { args: string[]; confirm: { path: string; token: string } }
    app = Bun.spawn([tmux, ...prepared.args], { terminal: { cols: 100, rows: 30, data: () => {} } })
    expect((await Bun.fetch(new URL(`/api/plugins/terminal${prepared.confirm.path}`, base()), { method: 'POST', headers: operator, body: JSON.stringify({ token: prepared.confirm.token, pid: app.pid }) })).status).toBe(200)
    // Device attributes asked once; every reply that reaches the program within a second is counted.
    // (A raw read that returns what has arrived: macOS's bash 3.2 drops a timed-out `read`'s input.)
    await typeLine(first, `sh -c 'stty -echo -icanon min 0 time 10; printf "\\033[c"; sleep 1; got=$(dd bs=4096 count=1 2>/dev/null); stty sane; n=$(printf %s "$got" | grep -o "\\[?[0-9;]*c" | wc -l); echo "answers=$((n))"'`)
    await waitForRow(first, '^answers=\\d+$', 15_000)
    const counted = (await rows(first)).find((row) => /^answers=\d+$/.test(row))
    expect(counted).toBe('answers=1')
    await waitForRow(second, '^answers=1$')
  } finally {
    app?.kill()
    await endSession(first, client, id)
    await browser.close()
  }
}, 60_000)

/** The first and last rows the screen reader sees (the visible window of the buffer). */
async function window_(page: Page): Promise<{ first: string; last: string }> {
  const all = (await rows(page)).map((row) => row.trim()).filter(Boolean)
  return { first: all[0] ?? '', last: all.at(-1) ?? '' }
}
/** Whether a row matches once the accessibility rows have caught up (hasRow reads them as they are). */
const shows = async (page: Page, pattern: string) => (await rows(page)).some((row) => new RegExp(pattern).test(row))
/** The visible window once it has stopped moving (a touch fling winds down). */
async function settled(page: Page): Promise<{ first: string; last: string }> {
  let last = await window_(page)
  for (let n = 0; n < 10; n++) {
    const next = await window_(page)
    if (next.first === last.first && next.last === last.last) return next
    last = next
  }
  throw new Error('the view never settled')
}
const wheelOver = async (page: Page, deltaY: number, times = 1) => {
  const box = (await page.locator('.terminal-pane').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let n = 0; n < times; n++) await page.mouse.wheel(0, deltaY)
}

rawTest('native scrolling (plan T36): the wheel scrolls the history to its top, pauses following, and ↓ Live comes back; output while scrolled up and the other viewer stay put', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-scroll-test-01'
  const page = await browser.newPage({ viewport })
  const other = await (await browser.newContext({ viewport })).newPage()
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await open(other, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 300')
    await waitForRow(page, '^line-300$')
    await waitForRow(other, '^line-300$')
    const otherLive = await window_(other)
    // Up into the history, past its top: it stops at the first line.
    await wheelOver(page, -2000, 20)
    await waitForRow(page, '^line-1$')
    await page.getByRole('button', { name: 'Follow cursor' }).waitFor()
    // The other viewer did not move (checked before it types anything).
    expect(await window_(other)).toEqual(otherLive)
    expect(await other.getByRole('button', { name: 'Follow cursor' }).count()).toBe(0)
    // Output while scrolled up (typed on the other viewer: typing here returns to the cursor, D10) does not move this view.
    await typeLine(other, 'seq -f "more-%g" 1 5')
    await waitForRow(other, '^more-5$')
    expect(await shows(page, '^more-5$')).toBe(false)
    expect((await window_(page)).first).toBe('line-1')
    // ↓ Live: the live screen again.
    await page.getByRole('button', { name: 'Follow cursor' }).click()
    await waitForRow(page, '^more-5$')
    expect(await page.getByRole('button', { name: 'Follow cursor' }).count()).toBe(0)
    // A short wheel up leaves the live screen; the wheel down comes back to it.
    await wheelOver(page, -400, 2)
    await page.getByRole('button', { name: 'Follow cursor' }).waitFor()
    expect(await shows(page, '^more-5$')).toBe(false)
    await wheelOver(page, 4000, 4)
    await waitForRow(page, '^more-5$')
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

rawTest('native scrolling (plan T36): dragging xterm\'s own scrollbar into the history pauses following too', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-scroll-test-04'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 300')
    await waitForRow(page, '^line-300$')
    const slider = page.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider')
    await page.locator('.xterm-scrollable-element').hover()
    const box = (await slider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y - 300, { steps: 10 })
    await page.mouse.up()
    await page.getByRole('button', { name: 'Follow cursor' }).waitFor({ timeout: 5_000 })
    expect(await shows(page, '^line-300$')).toBe(false)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

rawTest('native scrolling (plan T36, as native terminals): a full-screen program that asked for the mouse gets the wheel as scroll reports (and never a click); without the mouse it gets nothing and its screen does not scroll', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-scroll-test-02'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  try {
    await open(page, id)
    // A grid that fits the pane (nothing to pan first).
    Bun.spawnSync([tmux, '-S', socket, 'resize-window', '-t', id, '-x', '60', '-y', '15'])
    await page.waitForFunction(() => { const pane = document.querySelector('.terminal-pane')!; return pane.scrollHeight <= pane.clientHeight + 1 && pane.scrollWidth <= pane.clientWidth + 1 }, null, { timeout: 10_000 })
    await typeLine(page, 'seq -f "before-%g" 1 100')
    await waitForRow(page, '^before-100$')
    for (const [mouse, ready] of [['', 'STEADY'], ['\\033[?1000;1006h', 'READY']] as const) {
      // On the alternate screen, with or without mouse reporting (SGR); anything the program receives is shown by cat -v.
      await typeLine(page, `clear; printf '\\033[?1049h${mouse}%s%s\\n' ${ready.slice(0, 3)} ${ready.slice(3)}; stty -echo -icanon; cat -v`)
      await waitForRow(page, `^${ready}$`)
      const before = await rows(page)
      await wheelOver(page, -600, 5)
      await wheelOver(page, 600, 5)
      await page.waitForTimeout(1500)
      const received = (await rows(page)).join('\n')
      if (mouse) {
        // Wheel up (64) and down (65) reports, SGR; never a button press (0) — the wheel is not a click.
        expect(received).toMatch(/\^\[\[<64;\d+;\d+M/)
        expect(received).toMatch(/\^\[\[<65;\d+;\d+M/)
        expect(received).not.toMatch(/\^\[\[<0;/)
      } else {
        // No arrow keys, no reports; the alternate screen did not scroll.
        expect(received).not.toContain('^[')
        expect(await rows(page)).toEqual(before)
      }
      await page.keyboard.press('Control+C')
      await typeLine(page, `stty sane; printf '\\033[?1000;1006l\\033[?1049l'`)
    }
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)


// Touch is dispatched through Chromium's DevTools protocol.
const touchTest = process.env.TERMINAL_BROWSER === 'webkit' ? test.skip : rawTest
async function phone(client: string) {
  const browser = await launchChromium()
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const { id } = await createSession(page, client)
  const cdp = await context.newCDPSession(page)
  const pane = async () => (await page.locator('.terminal-pane').boundingBox())!
  /** One finger from one point of the pane to another, in ten moves; `meanwhile` runs before it lifts (or is cancelled). */
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, finish: 'touchEnd' | 'touchCancel' = 'touchEnd', meanwhile?: () => Promise<unknown>) => {
    const box = await pane()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + from.x, y: box.y + from.y }] })
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + from.x + ((to.x - from.x) * step) / 10, y: box.y + from.y + ((to.y - from.y) * step) / 10 }] })
    }
    await meanwhile?.()
    await cdp.send('Input.dispatchTouchEvent', { type: finish, touchPoints: [] })
  }
  const tap = async (at: { x: number; y: number }) => {
    const box = await pane()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + at.x, y: box.y + at.y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  return { browser, page, id, drag, tap, pane }
}

touchTest('native scrolling on a phone (plan T36): a one-finger drag down scrolls the history, a drag up comes back', async () => {
  const { browser, page, id, drag } = await phone('raw-browser-scroll-test-03')
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 200')
    await waitForRow(page, '^line-200$')
    const live = await window_(page)
    // Finger down: what is above comes into view (several drags reach well into the history).
    for (let n = 0; n < 4; n++) await drag({ x: 195, y: 100 }, { x: 195, y: 500 })
    const scrolled = await window_(page)
    expect(scrolled.last).not.toBe(live.last)
    await page.getByRole('button', { name: 'Follow cursor' }).waitFor()
    // Finger up: back down toward the live screen.
    for (let n = 0; n < 12; n++) await drag({ x: 195, y: 500 }, { x: 195, y: 100 })
    await waitForRow(page, '^line-200$')
  } finally {
    await endSession(page, 'raw-browser-scroll-test-03', id)
    await browser.close()
  }
}, 90_000)

touchTest('native scrolling on a phone (plan T36): a mostly horizontal drag in the history pans, never scrolls the history', async () => {
  const client = 'raw-browser-scroll-test-05'
  const { browser, page, id, drag } = await phone(client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 200')
    await waitForRow(page, '^line-200$')
    // A grid much wider than the phone: it pans sideways.
    Bun.spawnSync([tmux, '-S', socket, 'resize-window', '-t', id, '-x', '200', '-y', '40'])
    await page.waitForFunction(() => { const pane = document.querySelector('.terminal-pane')!; return pane.scrollWidth > pane.clientWidth + 100 }, null, { timeout: 10_000 })
    await drag({ x: 195, y: 100 }, { x: 195, y: 400 })
    await page.getByRole('button', { name: 'Follow cursor' }).waitFor()
    const before = await settled(page)
    const left = await page.evaluate(() => document.querySelector('.terminal-pane')!.scrollLeft)
    // Right to left, with a little vertical jitter.
    await drag({ x: 300, y: 300 }, { x: 60, y: 330 })
    await page.waitForFunction((start) => document.querySelector('.terminal-pane')!.scrollLeft > start, left, { timeout: 5_000 })
    expect(await window_(page)).toEqual(before)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

touchTest('native scrolling on a phone (plan T36): a tap never reaches a mouse-reporting program, and still focuses the terminal', async () => {
  const client = 'raw-browser-scroll-test-06'
  const { browser, page, id, tap } = await phone(client)
  try {
    await open(page, id)
    await typeLine(page, `clear; printf '\\033[?1049h\\033[?1003;1006h%s%s\\n' READ Y; stty -echo -icanon; cat -v`)
    await waitForRow(page, '^READY$')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    for (let n = 0; n < 3; n++) await tap({ x: 100 + n * 40, y: 120 })
    await page.waitForTimeout(1500)
    expect((await rows(page)).join('\n')).not.toContain('^[')
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true)
    await page.keyboard.press('Control+C')
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

/** The highest line-N the view shows (the bottom of what is visible). */
const lastLine = async (page: Page) => Math.max(...(await rows(page)).map((row) => Number(/^line-(\d+)$/.exec(row.trim())?.[1] ?? 0)))

touchTest('native scrolling on a phone (plan T36): a released drag flings on, a cancelled one stops where it was', async () => {
  const client = 'raw-browser-scroll-test-07'
  const { browser, page, id, drag } = await phone(client)
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 2000')
    await waitForRow(page, '^line-2000$')
    const moved = async (finish: 'touchEnd' | 'touchCancel') => {
      const from = await lastLine(page)
      await drag({ x: 195, y: 100 }, { x: 195, y: 400 }, finish)
      await settled(page)
      return from - await lastLine(page)
    }
    const cancelled = await moved('touchCancel')
    const released = await moved('touchEnd')
    expect(cancelled).toBeGreaterThan(0)
    // The same drag, released, keeps going well past where a cancelled one stopped.
    expect(released).toBeGreaterThan(cancelled * 2)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

touchTest('native scrolling on a phone (plan T36): returning to the cursor while a finger is still down ends that drag (no fling back into the history)', async () => {
  const client = 'raw-browser-scroll-test-08'
  const { browser, page, id, drag } = await phone(client)
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 2000')
    await waitForRow(page, '^line-2000$')
    await drag({ x: 195, y: 100 }, { x: 195, y: 500 }, 'touchEnd')
    await settled(page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // Down again, and before lifting the finger: focus the terminal to type (a deliberate return, D10).
    await drag({ x: 195, y: 100 }, { x: 195, y: 500 }, 'touchEnd', () => page.locator('.xterm-helper-textarea').focus())
    await settled(page)
    expect(await shows(page, '^line-2000$')).toBe(true)
    expect(await page.getByRole('button', { name: 'Follow cursor' }).count()).toBe(0)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

rawTest('native scrolling (plan T36): a selection pauses following, and ↓ Live clears it', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-scroll-test-09'
  const page = await browser.newPage({ viewport })
  const { id } = await createSession(page, client)
  // xterm's copy handler acts (and prevents the default) only while there is a selection.
  const selected = () => page.evaluate(() => {
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    document.querySelector('.xterm')!.dispatchEvent(copy)
    return copy.defaultPrevented
  })
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "line-%g" 1 20')
    await waitForRow(page, '^line-20$')
    expect(await selected()).toBe(false)
    const screen = (await page.locator('.xterm-screen').boundingBox())!
    await page.mouse.move(screen.x + 4, screen.y + 30)
    await page.mouse.down()
    await page.mouse.move(screen.x + 200, screen.y + 90, { steps: 8 })
    await page.mouse.up()
    expect(await selected()).toBe(true)
    await page.getByRole('button', { name: 'Follow cursor' }).click()
    expect(await selected()).toBe(false)
    expect(await page.getByRole('button', { name: 'Follow cursor' }).count()).toBe(0)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

/**
 * A recording clipboard (both browsers): every write the page makes, and how
 * the next one answers — `ok`, `refuse` (both the async API and the legacy
 * fallback fail), or `hold` (pending until `window.__clipboard.release()`).
 */
const RECORDING_CLIPBOARD = () => {
  const state = { writes: [] as string[], mode: 'ok' as 'ok' | 'refuse' | 'hold' | 'fallback', release: () => {} }
  Object.assign(window, { __clipboard: state })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: (text: string) => {
      state.writes.push(text)
      if (state.mode === 'refuse' || state.mode === 'fallback') return Promise.reject(new Error('refused'))
      if (state.mode === 'hold') return new Promise<void>((resolve) => { state.release = resolve })
      return Promise.resolve()
    },
  } })
  const exec = document.execCommand.bind(document)
  document.execCommand = (command: string, ...rest: unknown[]) => command === 'copy' && state.mode === 'refuse' ? false : exec(command, ...(rest as []))
}
type Recorded = { writes: string[]; mode: 'ok' | 'refuse' | 'hold' | 'fallback'; release(): void }
const clipboard = {
  writes: (page: Page) => page.evaluate(() => (window as unknown as { __clipboard: Recorded }).__clipboard.writes),
  mode: (page: Page, mode: Recorded['mode']) => page.evaluate((next) => { (window as unknown as { __clipboard: Recorded }).__clipboard.mode = next }, mode),
  release: (page: Page) => page.evaluate(() => (window as unknown as { __clipboard: Recorded }).__clipboard.release()),
}
const copyOffer = (on: Page) => on.getByRole('button', { name: 'Copy offered text' })
const offerLine = (text: string) => `printf '\\033]52;c;%s\\a' ${Buffer.from(text).toString('base64')}`
/** Absence cannot be polled for: give each page a moment after it went live, so an offer it would replay has landed. */
async function settleFor(...pages: Page[]): Promise<void> {
  for (const page of pages) await page.waitForTimeout(1_000)
}
async function recordingPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = { viewport }) {
  const context = await browser.newContext(options)
  await context.addInitScript(RECORDING_CLIPBOARD)
  return { context, page: await context.newPage() }
}

rawTest('clipboard offers (plan T36b): copied only on the tap, exactly, with the check; the latest replaces the last; a join, a reload, a reconnect or a recovery never replays one', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-offer-test-01'
  const { page } = await recordingPage(browser)
  const { page: other } = await recordingPage(browser)
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  const offered = 'línea uno ✓\nline two\ttabbed'
  try {
    await open(page, id)
    await open(other, id)
    expect(await copyOffer(page).count()).toBe(0)
    await typeLine(page, `${offerLine('first offer')}; ${offerLine(offered)}`)
    // A viewer that joins at once (the offers still in the join's tail, not yet in a checkpoint) is not offered them.
    const { page: late } = await recordingPage(browser)
    await open(late, id)
    // Every live viewer is offered it; only the latest, shown by its first line.
    await copyOffer(page).waitFor()
    await copyOffer(other).waitFor()
    expect(await copyOffer(page).count()).toBe(1)
    expect(await page.locator('.terminal-view-offer code').textContent()).toBe('línea uno ✓')
    // Nothing wrote the clipboard on its own.
    expect(await clipboard.writes(page)).toEqual([])
    expect(await clipboard.writes(other)).toEqual([])
    // A reload is not offered it again.
    await other.reload()
    await other.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    await settleFor(late, other)
    expect(await copyOffer(late).count()).toBe(0)
    expect(await copyOffer(other).count()).toBe(0)
    // The tap copies the whole text, exactly; the kit's check shows, then the offer is done.
    await copyOffer(page).click()
    await page.getByRole('button', { name: 'Copy offered text complete' }).waitFor({ timeout: 2_000 })
    await page.locator('.terminal-view-offer').waitFor({ state: 'detached', timeout: 5_000 })
    expect(await clipboard.writes(page)).toEqual([offered])
    // A reconnect and a recovery (Bakin's control client lost: the viewers rejoin a rebuilt replica) replay nothing.
    const control = Bun.spawnSync([tmux, '-S', socket, 'list-clients', '-t', id, '-F', '#{client_control_mode} #{client_name}']).stdout.toString()
      .split('\n').filter((line) => line.startsWith('1 ')).map((line) => line.slice(2))
    Bun.spawnSync([tmux, '-S', socket, 'detach-client', '-t', control[0]!])
    await page.getByRole('status', { name: 'Terminal view recovered with limitations' }).waitFor({ timeout: 20_000 })
    await settleFor(page)
    expect(await copyOffer(page).count()).toBe(0)
    expect(await clipboard.writes(page)).toEqual([offered])
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

rawTest('clipboard offers (plan T36b): a refused write keeps the offer; a copy that settles after a newer offer neither clears nor confirms it', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-offer-test-02'
  const { page } = await recordingPage(browser)
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, offerLine('refused one'))
    await copyOffer(page).waitFor()
    await clipboard.mode(page, 'refuse')
    await copyOffer(page).click()
    await settleFor(page)
    expect(await copyOffer(page).count()).toBe(1)
    expect(await page.locator('.terminal-view-offer code').textContent()).toBe('refused one')
    // A copy held pending; a newer offer arrives; then the first write lands.
    await clipboard.mode(page, 'hold')
    await copyOffer(page).click()
    await typeLine(page, offerLine('the newer one'))
    await page.locator('.terminal-view-offer code', { hasText: 'the newer one' }).waitFor()
    await clipboard.release(page)
    // The kit's check would show at once (and clear after 1.5 s): look while it would be up.
    await page.waitForTimeout(300)
    expect(await page.getByRole('button', { name: 'Copy offered text complete' }).count()).toBe(0)
    // And the newer offer stays past when a copied one would have gone.
    await page.waitForTimeout(2_000)
    expect(await page.locator('.terminal-view-offer code').textContent()).toBe('the newer one')
    expect(await clipboard.writes(page)).toEqual(['refused one', 'refused one'])
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

touchTest('clipboard offers on a 320 px phone (plan T36b): the offer, ↓ Live, Reset view and Show keyboard all fit the corner, none over another', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-offer-test-03'
  const { context, page } = await recordingPage(browser, { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })
  // A pinched font remembered on this device: Reset view shows.
  await context.addInitScript(() => { try { localStorage.setItem('bakin-terminal-font', '14') } catch { /* storage blocked: the test fails visibly below */ } })
  const { id } = await createSession(page, client)
  const cdp = await context.newCDPSession(page)
  try {
    await open(page, id)
    await typeLine(page, `clear; seq -f "line-%g" 1 200; ${offerLine('a long offered line that cannot fit the corner of a small phone')}`)
    await copyOffer(page).waitFor()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // Into the history: ↓ Live shows.
    const box = (await page.locator('.terminal-pane').boundingBox())!
    // (Below the corner: a drag that starts on the controls is not the pane's.)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 160, y: box.y + 200 }] })
    for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 160, y: box.y + 200 + step * 30 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const controls = [copyOffer(page), page.getByRole('button', { name: 'Follow cursor' }), page.getByRole('button', { name: 'Reset view' }), page.getByRole('button', { name: 'Show keyboard' })]
    for (const control of controls) await control.waitFor({ timeout: 5_000 })
    const boxes = await Promise.all([page.locator('.terminal-view-offer'), ...controls.slice(1)].map(async (control) => (await control.boundingBox())!))
    for (const { x, width } of boxes) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x + width).toBeLessThanOrEqual(320)
    }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const [one, two] = [boxes[a]!, boxes[b]!]
      const overlap = one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height
      expect(overlap).toBe(false)
    }
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

rawTest('on a phone (plan T36b) the persistent recovery notice folds to its title; Show details shows the rest', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-recovery-test-02'
  const page = await (await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true })).newPage()
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  const notice = page.getByRole('status', { name: 'Terminal view recovered with limitations' })
  try {
    await open(page, id)
    const control = Bun.spawnSync([tmux, '-S', socket, 'list-clients', '-t', id, '-F', '#{client_control_mode} #{client_name}']).stdout.toString()
      .split('\n').filter((line) => line.startsWith('1 ')).map((line) => line.slice(2))
    Bun.spawnSync([tmux, '-S', socket, 'detach-client', '-t', control[0]!])
    await notice.waitFor({ timeout: 20_000 })
    expect(await notice.textContent()).not.toContain('Cause:')
    const toggle = notice.getByRole('button', { name: 'Show details' })
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await toggle.click()
    await expect(notice.textContent()).resolves.toContain("Cause: the view's connection to tmux was replaced.")
    expect(await notice.getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe('true')
    await notice.getByRole('button', { name: 'Hide details' }).click()
    expect(await notice.textContent()).not.toContain('Cause:')
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

rawTest('clipboard offers (plan T36b): focus — a replaced offer keeps a keyboard user on Copy; a copy through the fallback (copied or refused) leaves the view in the history; a pending offer survives a recovery', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-offer-test-04'
  const { page } = await recordingPage(browser)
  const other = await (await browser.newContext({ viewport })).newPage()
  const { id } = await createSession(page, client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  const live = page.getByRole('button', { name: 'Follow cursor' })
  try {
    await open(page, id)
    await open(other, id)
    await typeLine(page, offerLine('offer A'))
    await copyOffer(page).waitFor()
    // Keyboard focus on Copy; the program offers again (typed on the other viewer, so this one is not refocused).
    await copyOffer(page).focus()
    await typeLine(other, offerLine('offer B'))
    await page.locator('.terminal-view-offer code', { hasText: 'offer B' }).waitFor()
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-slot'))).toBe('copy-button')
    // Paused in the history while on Copy, the offer replaced again: deliberately focusing the terminal still returns to the cursor.
    await typeLine(other, 'seq -f "fill-%g" 1 200')
    await waitForRow(other, '^fill-200$')
    await wheelOver(page, -1000, 3)
    await live.waitFor()
    await typeLine(other, offerLine('offer B2'))
    await page.locator('.terminal-view-offer code', { hasText: 'offer B2' }).waitFor()
    await page.locator('.xterm-helper-textarea').focus()
    await live.waitFor({ state: 'detached', timeout: 5_000 })
    // The terminal focused, then into the history; copying through the fallback path keeps the view there.
    await typeLine(page, 'clear; seq -f "line-%g" 1 300')
    await waitForRow(page, '^line-300$')
    await typeLine(page, offerLine('offer C'))
    await page.locator('.terminal-view-offer code', { hasText: 'offer C' }).waitFor()
    await wheelOver(page, -2000, 5)
    await live.waitFor()
    for (const mode of ['refuse', 'fallback'] as const) {
      await clipboard.mode(page, mode)
      await copyOffer(page).click()
      await settleFor(page)
      expect(await live.count()).toBe(1)
      expect(await shows(page, '^line-300$')).toBe(false)
      expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true)
    }
    // A pending offer (refused above, or copied and showing its check) and a recovery: it is neither lost nor doubled.
    await clipboard.mode(page, 'refuse')
    await typeLine(other, offerLine('offer D'))
    await page.locator('.terminal-view-offer code', { hasText: 'offer D' }).waitFor()
    const control = Bun.spawnSync([tmux, '-S', socket, 'list-clients', '-t', id, '-F', '#{client_control_mode} #{client_name}']).stdout.toString()
      .split('\n').filter((line) => line.startsWith('1 ')).map((line) => line.slice(2))
    Bun.spawnSync([tmux, '-S', socket, 'detach-client', '-t', control[0]!])
    await page.getByRole('status', { name: 'Terminal view recovered with limitations' }).waitFor({ timeout: 20_000 })
    await settleFor(page)
    expect(await copyOffer(page).count()).toBe(1)
    expect(await page.locator('.terminal-view-offer code').textContent()).toBe('offer D')
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

rawTest('clipboard offers (plan T36b): labelled and previewed by their first line with text; Dismiss clears one without writing anything', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-offer-test-05'
  const { page } = await recordingPage(browser)
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, offerLine('\n\n  the real first line\nand a second'))
    await copyOffer(page).waitFor()
    const panel = page.locator('.terminal-view-offer')
    expect(await panel.locator('code').textContent()).toBe('the real first line')
    expect(await panel.textContent()).toContain('Text to copy · 4 lines')
    await panel.getByRole('button', { name: 'Dismiss the offered text' }).click()
    await panel.waitFor({ state: 'detached' })
    expect(await clipboard.writes(page)).toEqual([])
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

rawTest('Copy text: the session menu opens the terminal\'s text as page text (history and screen, wrapped lines whole); Copy all copies it exactly', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-copy-text-01'
  const { page } = await recordingPage(browser, { viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true })
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, `clear; seq -f "row-%g" 1 300; printf '%s%s\\n' "$(printf 'w%.0s' $(seq 1 150))" END`)
    await waitForRow(page, 'END$')
    await page.getByRole('button', { name: 'Session actions' }).click()
    await page.getByRole('menuitem', { name: 'Copy text…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Copy text' })
    await sheet.waitFor()
    await page.waitForFunction(() => { const panel = document.querySelector('[role=dialog]'); return Boolean(panel) && getComputedStyle(panel!).opacity === '1' && !panel!.hasAttribute('data-starting-style') })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/raw/copy-text-phone.png') })
    const text = await sheet.locator('[data-slot="code-block"] code, [data-slot="code-block"] pre').first().textContent() ?? ''
    // History back to the first row, and the long line whole (it wrapped on screen).
    expect(text).toContain('row-1\nrow-2\n')
    expect(text).toContain(`${'w'.repeat(150)}END`)
    // Plain page text: the system's own selection works on it.
    expect(await sheet.evaluate((element) => getComputedStyle(element.querySelector('[data-slot="code-block"]')!).userSelect)).not.toBe('none')
    await sheet.getByRole('button', { name: 'Copy all terminal text' }).click()
    const written = (await clipboard.writes(page))[0] ?? ''
    expect(written.split('\n').filter((line) => line.startsWith('row-'))).toHaveLength(300)
    expect(written).toContain(`${'w'.repeat(150)}END`)
    await sheet.getByRole('button', { name: 'Close' }).first().click()
    await sheet.waitFor({ state: 'detached' })
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)

rawTest('Copy text: more than 2,000 lines shows the newest and copies every one exactly; reopening takes new output; before the first picture it says the terminal is connecting', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-copy-text-02'
  const { page } = await recordingPage(browser, { viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true })
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, 'clear; seq -f "row-%g" 1 2500')
    await waitForRow(page, '^row-2500$')
    await page.getByRole('button', { name: 'Session actions' }).click()
    await page.getByRole('menuitem', { name: 'Copy text…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Copy text' })
    await sheet.getByText(/Showing the newest part of/).waitFor()
    const shown = await sheet.locator('[data-slot="code-block"]').textContent() ?? ''
    expect(shown).toContain('row-2500')
    expect(shown).not.toContain('row-1\n')
    await sheet.getByRole('button', { name: 'Copy all terminal text' }).click()
    const written = (await clipboard.writes(page))[0] ?? ''
    // Every row, in order, exactly once.
    const rows = written.split('\n').filter((line) => /^row-\d+$/.test(line))
    expect(rows).toEqual(Array.from({ length: 2500 }, (_, n) => `row-${n + 1}`))
    // New output, then opening again: a new snapshot takes it.
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    await typeLine(page, `printf '%s-%s\\n' after refresh`)
    await waitForRow(page, '^after-refresh$')
    await page.getByRole('button', { name: 'Session actions' }).click()
    await page.getByRole('menuitem', { name: 'Copy text…' }).click()
    await sheet.waitFor()
    expect(await sheet.locator('[data-slot="code-block"]').textContent()).toContain('after-refresh')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    // A fresh page whose viewer socket is held off: no picture yet, so it says so (not "no text").
    const held = await (await browser.newContext({ viewport: { width: 390, height: 760 } })).newPage()
    const socket = await viewerSocket(held)
    socket.block(true)
    await held.goto(new URL(`/terminal/${id}`, base()).href)
    await held.getByRole('button', { name: 'Session actions' }).click()
    await held.getByRole('menuitem', { name: 'Copy text…' }).click()
    const waiting = held.getByRole('dialog', { name: 'Copy text' })
    await waiting.getByText('The terminal is still connecting; refresh once it shows its output.').waitFor()
    // Let it connect: Refresh then shows the output.
    socket.block(false)
    await held.reload()
    await held.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    // Reconnect terminal starts a fresh terminal: held off again, it has shown nothing yet (not "no text").
    socket.block(true)
    await held.getByRole('button', { name: 'Session actions' }).click()
    await held.getByRole('menuitem', { name: 'Reconnect terminal' }).click()
    await held.getByRole('button', { name: 'Session actions' }).click()
    await held.getByRole('menuitem', { name: 'Copy text…' }).click()
    await waiting.getByText('The terminal is still connecting; refresh once it shows its output.').waitFor()
    socket.block(false)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 90_000)

touchTest('native scrolling on a phone (as native terminals): a vertical drag in a full-screen program that asked for the mouse reaches it as scroll reports; a tap still never does', async () => {
  const client = 'raw-browser-scroll-test-10'
  const { browser, page, id, drag, tap } = await phone(client)
  const tmux = process.env.TERMINAL_PREVIEW_TMUX!
  const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
  try {
    await open(page, id)
    // A grid that fits the phone's pane: the drag has nothing to pan first.
    Bun.spawnSync([tmux, '-S', socket, 'resize-window', '-t', id, '-x', '40', '-y', '12'])
    await page.waitForFunction(() => { const pane = document.querySelector('.terminal-pane')!; return pane.scrollHeight <= pane.clientHeight + 1 }, null, { timeout: 10_000 })
    await typeLine(page, `clear; printf '\\033[?1049h\\033[?1003;1006h%s%s\\n' READ Y; stty -echo -icanon; cat -v`)
    await waitForRow(page, '^READY$')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await tap({ x: 120, y: 60 })
    await drag({ x: 150, y: 80 }, { x: 150, y: 240 })
    await page.waitForTimeout(1500)
    const received = (await rows(page)).join('\n')
    // Finger down shows what is above: wheel-up reports. No click from the tap.
    expect(received).toMatch(/\^\[\[<64;\d+;\d+M/)
    expect(received).not.toMatch(/\^\[\[<0;/)
    expect(received).not.toMatch(/\^\[\[<35;/)
    await page.keyboard.press('Control+C')
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 60_000)
