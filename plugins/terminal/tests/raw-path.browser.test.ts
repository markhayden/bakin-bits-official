import { expect, test } from 'bun:test'
import { TerminalService } from '../lib/service'
import { launchChromium } from './browser'

// Spec D13 / plan T33: the raw path against the preview with it forced on
// (TERMINAL_PREVIEW_RAW=1 for both the preview and this run). Joins during
// output, mid-escape, in the alternate screen and with more than 2k rows;
// keystroke-to-echo in normal use; and the overload gate.
// The overload test reads the pane from tmux: TERMINAL_PREVIEW_TMUX and
// TERMINAL_PREVIEW_ROOT are the tmux and workingDirectory the preview printed.
const rawTest = process.env.TERMINAL_PREVIEW_URL && process.env.TERMINAL_PREVIEW_RAW === '1' ? test : test.skip

type Browser = Awaited<ReturnType<typeof launchChromium>>
type Page = Awaited<ReturnType<Browser['newPage']>>

const base = () => process.env.TERMINAL_PREVIEW_URL!
const endpoint = (path: string) => new URL(`/api/plugins/terminal${path}`, base()).href

async function createSession(page: Page, client: string): Promise<{ id: string }> {
  const created = await page.request.post(endpoint('/sessions'), { headers: { 'X-Bakin-Terminal-Client': client }, data: { title: 'Raw path', cwd: '/tmp' } })
  return created.json() as Promise<{ id: string }>
}
async function endSession(page: Page, client: string, id: string): Promise<void> {
  const headers = { 'X-Bakin-Terminal-Client': client }
  const taken = await (await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'take' } })).json() as { generation: number }
  await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'terminate', generation: taken.generation } })
}
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
const waitForRow = (page: Page, predicate: string, timeout = 10_000) =>
  page.waitForFunction((pattern) => [...document.querySelectorAll('.xterm-accessibility-tree > div')].some((row) => new RegExp(pattern).test(row.textContent ?? '')), predicate, { timeout })

rawTest('a viewer that joins during output, mid-escape and in the alternate screen sees what the first one sees', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-join-test-01'
  const first = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const { id } = await createSession(first, client)
  try {
    await open(first, id)
    // Numbered output for a while; a second viewer joins in the middle of it.
    await typeLine(first, "clear; for i in $(seq 1 400); do echo \"line $i\"; sleep 0.005; done; echo output-done")
    await waitForRow(first, '^line 1\\d\\d')
    const second = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    await open(second, id)
    await waitForRow(first, '^output-done')
    await waitForRow(second, '^output-done')
    expect(await rows(second)).toEqual(await rows(first))
    // Mid-escape: a CSI split around the join leaves no stray characters.
    await typeLine(first, "clear; printf 'before\\033['; sleep 1.5; printf '2Jafter-escape\\n'")
    await waitForRow(first, '^before')
    const third = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    await open(third, id)
    await waitForRow(third, 'after-escape')
    expect((await rows(third)).join('\n')).not.toContain('[2J')
    expect(await rows(third)).toEqual(await rows(first))
    // The alternate screen: joined inside it, and the normal screen comes back whole.
    await typeLine(first, "clear; echo normal-screen; printf '\\033[?1049h\\033[Halternate-screen'; sleep 6; printf '\\033[?1049l'")
    await waitForRow(first, 'alternate-screen')
    const fourth = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    await open(fourth, id)
    await waitForRow(fourth, 'alternate-screen')
    await waitForRow(fourth, '^normal-screen', 10_000)
    expect(await rows(fourth)).toEqual(await rows(first))
  } finally {
    await endSession(first, client, id)
    await browser.close()
  }
}, 120_000)

rawTest('a join carries more than 2,000 retained rows of scrollback', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-scroll-test-01'
  const first = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const { id } = await createSession(first, client)
  try {
    await open(first, id)
    await typeLine(first, 'clear; seq 1 3000; echo history-done')
    await waitForRow(first, '^history-done')
    const joined = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    await open(joined, id)
    await waitForRow(joined, '^history-done')
    // xterm's own scroll area holds the retained rows: at the top, the first of them.
    const retained = await joined.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.xterm-viewport, .xterm-scrollable-element')!
      const row = document.querySelector<HTMLElement>('.xterm-accessibility-tree > div')!.getBoundingClientRect().height
      return Math.round(scroller.scrollHeight / row)
    })
    expect(retained).toBeGreaterThan(2000)
  } finally {
    await endSession(first, client, id)
    await browser.close()
  }
}, 120_000)

rawTest('keystroke to visible echo is under 50 ms at the 95th percentile in normal use', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-echo-test-01'
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const { id } = await createSession(page, client)
  try {
    await open(page, id)
    await typeLine(page, 'clear; cat')
    // Measured in the page, from the key event to the echoed character in the
    // screen-reader rows (refreshed on render; one a second at most, so the
    // keys are spaced past both that refresh and its trailing one).
    await page.evaluate(() => {
      const w = window as unknown as { pressed: number; want: string; seen: number; samples: number[] }
      const tree = document.querySelector('.xterm-accessibility-tree')!
      w.samples = []
      document.addEventListener('keydown', (event) => {
        if (event.key.length !== 1) return
        w.pressed = performance.now()
        w.want = event.key
        w.seen = (tree.textContent ?? '').split(event.key).length
      }, true)
      new MutationObserver(() => {
        if (w.pressed && (tree.textContent ?? '').split(w.want).length > w.seen) { w.samples.push(performance.now() - w.pressed); w.pressed = 0 }
      }).observe(tree, { subtree: true, childList: true, characterData: true })
    })
    await page.locator('.xterm-helper-textarea').focus()
    for (let i = 0; i < 32; i++) { await page.waitForTimeout(2_100); await page.keyboard.type(String.fromCharCode(97 + (i % 26))) }
    await page.waitForTimeout(500)
    // The first two warm the path up.
    const samples = (await page.evaluate(() => (window as unknown as { samples: number[] }).samples)).slice(2).sort((a, b) => a - b)
    expect(samples.length).toBeGreaterThanOrEqual(28)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!
    console.log(`echo p50 ${samples[Math.floor(samples.length / 2)]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (${samples.map((n) => n.toFixed(0)).join(' ')})`)
    expect(p95).toBeLessThan(50)
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 150_000)

rawTest('overload: a flood with a stalled viewer — the stalled one is evicted, Ctrl-C works within a second, and the display converges', async () => {
  const browser = await launchChromium()
  const client = 'raw-browser-flood-test-01'
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const { id } = await createSession(page, client)
  // A viewer (a page's own socket) that joins and never retires anything: the window fills.
  const stalledPage = await browser.newPage()
  // Same origin as the socket (the host's cross-site guard); the page itself is not used.
  await stalledPage.goto(new URL('/', base()).href)
  await stalledPage.evaluate((id) => {
    const url = new URL(`/api/plugins/terminal/socket?id=${id}`, location.href)
    url.protocol = 'ws:'
    const socket = new WebSocket(url.href)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', clientId: 'raw-stalled-viewer-0001' }))
    socket.onclose = (event) => { (window as unknown as { stalledCode: number }).stalledCode = event.code }
  }, id)
  const stalledClosed = () => stalledPage.evaluate(() => (window as unknown as { stalledCode?: number }).stalledCode)
  try {
    await open(page, id)
    const floodStarted = Date.now()
    await typeLine(page, 'yes raw-flood | head -c 400000000')
    await page.waitForTimeout(5_000)
    // The stalled viewer is evicted: its window fills at once, then the stall window (10 s) runs out.
    let closed = await stalledClosed()
    while (closed === undefined && Date.now() - floodStarted < 20_000) { await page.waitForTimeout(100); closed = await stalledClosed() }
    const evicted = Date.now() - floodStarted
    console.log(`stalled viewer closed ${closed} after ${evicted} ms`)
    expect(closed).toBe(4000)
    expect(evicted).toBeLessThan(15_000)
    // Ctrl-C stops the flood within a second (input never queued behind replica work):
    // tmux itself says when the pane's program is no longer `yes`.
    const tmux = process.env.TERMINAL_PREVIEW_TMUX
    const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
    const command = () => Bun.spawnSync([tmux!, '-S', socket, 'display', '-p', '-t', id, '#{pane_current_command}']).stdout.toString().trim()
    expect(command()).toBe('yes')
    const interrupted = Date.now()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+C')
    while (command() === 'yes' && Date.now() - interrupted < 5_000) await Bun.sleep(10)
    const stopped = Date.now() - interrupted
    console.log(`Ctrl-C to the flood stopped: ${stopped} ms`)
    expect(stopped).toBeLessThan(1_000)
    // The display catches up (lag of about a second allowed under overload), then a fresh viewer agrees.
    await typeLine(page, 'echo flood-stopped')
    await waitForRow(page, '^flood-stopped', 10_000)
    const fresh = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    await open(fresh, id)
    await waitForRow(fresh, '^flood-stopped')
    await page.waitForTimeout(500)
    expect(await rows(fresh)).toEqual(await rows(page))
  } finally {
    await endSession(page, client, id)
    await browser.close()
  }
}, 120_000)
