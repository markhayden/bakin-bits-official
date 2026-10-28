import { expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserTest, launchChromium, viewerSocket } from './browser'

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchChromium>>['newPage']>>

/** The on-screen keyboard as the page sees it: the (faked) visual viewport shrinking to `height`. */
async function keyboard(page: Page, height: number) {
  await page.evaluate((height) => {
    Object.assign(window.visualViewport!, { height })
    window.visualViewport!.dispatchEvent(new Event('resize'))
  }, height)
}
async function fakeViewport(page: Page, width: number, height: number) {
  await page.addInitScript(({ width, height }) => {
    const viewport = Object.assign(new EventTarget(), { height, width, offsetTop: 0, offsetLeft: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  }, { width, height })
}
async function terminate(page: Page, endpoint: string, headers: Record<string, string>, id: string | undefined) {
  if (!id) return
  const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
  const session = await taken.json()
  await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
}

browserTest('the phone key bar follows the typing session and its keys send exact bytes', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true })
  page.setDefaultTimeout(10000)
  const root = mkdtempSync(join(tmpdir(), 'terminal-keys-'))
  writeFileSync(join(root, 'completion-proof'), 'COMPLETION_OK\n')
  const headers = { 'X-Bakin-Terminal-Client': 'mobile-browser-test' }
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  let id: string | undefined
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const socket = await viewerSocket(page)
  await fakeViewport(page, 320, 800)
  const output = async (text: string) => page.waitForFunction(text => document.querySelector('.xterm-accessibility-tree')?.textContent?.replace(/\s+/g, ' ').includes(text), text)
  const sent = async (bytes: string) => socket.waitFor((frame) => frame.type === 'input' && String(frame.data).includes(bytes))
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Mobile keys', cwd: root } })
    expect(created.ok()).toBe(true)
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    // A session made over the API is nobody's size yet: this phone takes it, so the grid fits above the keys.
    await page.locator('[data-slot="workspace-page-compact-header"]').getByRole('button', { name: /^Terminal size / }).tap()
    await page.getByRole('button', { name: 'Fit to this device', exact: true }).tap()
    await page.waitForFunction(() => document.querySelector('.terminal-pane')?.getAttribute('data-fit') === 'pane')
    await page.keyboard.press('Escape')

    // Not typing: no bar, only the corner keyboard button, which starts typing.
    const keys = page.getByRole('group', { name: 'Terminal keys', exact: true })
    expect(await keys.count()).toBe(0)
    const input = page.locator('.xterm-helper-textarea')
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).tap()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await keys.waitFor()
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled === false)

    // Tab completes and the keyboard (focus) stays.
    await page.keyboard.type('cat completion-pr')
    await keys.getByRole('button', { name: 'Tab', exact: true }).tap()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await output('COMPLETION_OK')

    // Ctrl, one shot: Ctrl then c interrupts, and Ctrl releases.
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    await keys.getByRole('button', { name: 'Control', exact: true }).tap()
    expect(await keys.getByRole('button', { name: 'Control, on for the next key', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.type('c')
    await sent('\x03')
    await keys.getByRole('button', { name: 'Control', exact: true }).waitFor()

    // Option prefixes ESC (terminal Meta): ⌥ then b is ESC b.
    await keys.getByRole('button', { name: 'Option', exact: true }).tap()
    await page.keyboard.type('b')
    await sent('\x1bb')
    await keys.getByRole('button', { name: 'Option', exact: true }).waitFor()

    // The sheet: the keyboard goes down (focus leaves the input), the bar stays, keys send.
    await keys.getByRole('button', { name: 'More keys', exact: true }).tap()
    const sheet = page.getByRole('region', { name: 'More keys' })
    await sheet.waitFor()
    await page.waitForFunction(() => !document.activeElement?.classList.contains('xterm-helper-textarea'))
    await page.waitForTimeout(300)
    expect(await keys.count()).toBe(1)
    await sheet.getByRole('button', { name: 'Ctrl+U Delete line', exact: true }).tap()
    await sent('\x15')
    // A raw application enables DECCKM; the sheet's Up sends SS3 then.
    await keys.getByRole('button', { name: 'Back to keyboard', exact: true }).tap()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await sheet.waitFor({ state: 'detached' })
    await page.keyboard.type("stty -icanon -echo; printf '\\033[?1hAPP_%s\\n' READY; dd bs=1 count=3 2>/dev/null | od -An -tx1; printf '\\033[?1l'; stty sane")
    await page.keyboard.press('Enter')
    await output('APP_READY')
    await keys.getByRole('button', { name: 'More keys', exact: true }).tap()
    await sheet.getByRole('button', { name: 'Up', exact: true }).tap()
    await output('1b 4f 41')

    // A lock holds across keys and never applies twice: locked Ctrl + the sheet's Left is CSI 1;5 D once.
    await sheet.getByRole('button', { name: 'Control lock', exact: true }).tap()
    expect(await keys.getByRole('button', { name: 'Control, locked', exact: true }).getAttribute('aria-pressed')).toBe('true')
    const before = socket.typed().length
    await sheet.getByRole('button', { name: 'Left', exact: true }).tap()
    await sent('\x1b[1;5D')
    expect(socket.typed().slice(before)).toBe('\x1b[1;5D')
    await sheet.getByRole('button', { name: 'Right', exact: true }).tap()
    await sent('\x1b[1;5C')
    await keys.getByRole('button', { name: 'Control, locked', exact: true }).tap()
    await keys.getByRole('button', { name: 'Control', exact: true }).waitFor()

    // Back to typing, then the keyboard getting taller: the bar sits above it, the pane above the bar.
    await keys.getByRole('button', { name: 'Back to keyboard', exact: true }).tap()
    await keyboard(page, 350.5)
    await page.waitForFunction(() => {
      const output = document.querySelector<HTMLElement>('.terminal-pane')!.getBoundingClientRect()
      const bar = document.querySelector('.terminal-key-accessory')!.getBoundingClientRect()
      return output.bottom <= bar.top + 1 && bar.bottom <= 351.5
    })
    // At 320 px the row fits without scrolling, every cap at least 38 px wide.
    expect(await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.terminal-key-bar')!
      const caps = [...row.querySelectorAll('button')].map(cap => cap.getBoundingClientRect().width)
      return { fits: row.scrollWidth <= row.clientWidth, narrowest: Math.min(...caps) }
    })).toEqual({ fits: true, narrowest: expect.any(Number) })
    expect(await page.evaluate(() => Math.min(...[...document.querySelectorAll('.terminal-key-bar button')].map(cap => cap.getBoundingClientRect().width)))).toBeGreaterThanOrEqual(40)
    // Hit areas meet in the gaps but never overlap: 1.5 px either side of each
    // gap's middle (hit testing rounds fractional points), the nearer key answers.
    expect(await page.evaluate(() => {
      const caps = [...document.querySelectorAll<HTMLButtonElement>('.terminal-key-bar button')]
      const wrong: string[] = []
      for (let i = 0; i + 1 < caps.length; i++) {
        const a = caps[i]!.getBoundingClientRect(), b = caps[i + 1]!.getBoundingClientRect()
        if (b.left - a.right > 8) continue
        const y = a.top + a.height / 2, middle = (a.right + b.left) / 2
        if (document.elementFromPoint(middle - 1.5, y)?.closest('button') !== caps[i]) wrong.push(`${caps[i]!.ariaLabel} right`)
        if (document.elementFromPoint(middle + 1.5, y)?.closest('button') !== caps[i + 1]) wrong.push(`${caps[i + 1]!.ariaLabel} left`)
      }
      return wrong
    })).toEqual([])
    const images = join(import.meta.dir, '../test-results/mobile-input')
    mkdirSync(images, { recursive: true })
    await page.screenshot({ path: join(images, (process.env.TERMINAL_BROWSER ?? 'chromium') + '-keyboard-open.png') })

    // (Focus reports while the sheet opens are covered in modifier-input.test.ts:
    // tmux consumes ?1004h today, so the browser terminal never reports focus.)

    // IME: a composed word under a locked Control is sent as typed, and the lock
    // stays (Chromium drives a real composition). A single key takes the lock.
    if (process.env.TERMINAL_BROWSER !== 'webkit') {
      await keys.getByRole('button', { name: 'More keys', exact: true }).tap()
      await sheet.getByRole('button', { name: 'Control lock', exact: true }).tap()
      await keys.getByRole('button', { name: 'Back to keyboard', exact: true }).tap()
      const ime = await page.context().newCDPSession(page)
      const before = socket.typed().length
      await ime.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
      await ime.send('Input.insertText', { text: '你好' })
      await socket.waitFor(() => socket.typed().slice(before).includes('你好'))
      expect(socket.typed().slice(before)).toBe('你好')
      await ime.detach()
      expect(await keys.getByRole('button', { name: 'Control, locked', exact: true }).isVisible()).toBe(true)
      await keys.getByRole('button', { name: 'Control, locked', exact: true }).tap()
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
    }

    // A paste under a locked Control is sent exactly as pasted (bracketed when the shell asked for it).
    await keys.getByRole('button', { name: 'More keys', exact: true }).tap()
    await sheet.getByRole('button', { name: 'Control lock', exact: true }).tap()
    await keys.getByRole('button', { name: 'Back to keyboard', exact: true }).tap()
    const beforePaste = socket.typed().length
    await input.evaluate((el) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'c')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await socket.waitFor((frame) => frame.type === 'input' && String(frame.data).includes('c') && socket.typed().length > beforePaste)
    expect(['c', '\x1b[200~c\x1b[201~']).toContain(socket.typed().slice(beforePaste))
    expect(await keys.getByRole('button', { name: 'Control, locked', exact: true }).isVisible()).toBe(true)
    await keys.getByRole('button', { name: 'Control, locked', exact: true }).tap()
    await page.keyboard.press('Backspace')

    // Hide keyboard ends the session: no bar, the corner button is back.
    await keys.getByRole('button', { name: 'Hide keyboard', exact: true }).tap()
    await keys.waitFor({ state: 'detached' })
    expect(await input.evaluate(el => el === document.activeElement)).toBe(false)
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally {
    try { await terminate(page, endpoint, headers, id) }
    finally { await browser.close(); rmSync(root, { recursive: true, force: true }) }
  }
}, 90000)

browserTest('return on the on-screen keyboard sends the line and puts the keyboard away; a hardware Enter keeps it', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  page.setDefaultTimeout(10000)
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  const headers = { 'X-Bakin-Terminal-Client': 'mobile-enter-hides-test' }
  let id: string | undefined
  const socket = await viewerSocket(page)
  await fakeViewport(page, 390, 844)
  const output = async (text: string) => page.waitForFunction(text => document.querySelector('.xterm-accessibility-tree')?.textContent?.replace(/\s+/g, ' ').includes(text), text)
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Enter hides', cwd: '/tmp' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    const input = page.locator('.xterm-helper-textarea')
    await input.waitFor({ state: 'attached' })
    const keys = page.getByRole('group', { name: 'Terminal keys', exact: true })
    // A hardware keyboard (a physical key code, nothing covering the screen): Enter keeps typing.
    await input.focus()
    await keys.waitFor()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled === false)
    await page.keyboard.type("printf 'HARD_%s\\n' ENTER")
    await page.keyboard.press('Enter')
    await output('HARD_ENTER')
    await page.waitForTimeout(200)
    expect(await keys.count()).toBe(1)
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    // The on-screen keyboard up (the screen covered): return sends, then the keyboard goes.
    await keyboard(page, 500)
    await page.keyboard.type("printf 'SOFT_%s\\n' ENTER")
    await page.keyboard.press('Enter')
    await socket.waitFor((frame) => frame.type === 'input' && String(frame.data).includes('\r') && socket.typed().includes('SOFT_'))
    await output('SOFT_ENTER')
    await keys.waitFor({ state: 'detached' })
    expect(await input.evaluate(el => el === document.activeElement)).toBe(false)
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).waitFor()
    // A keyboard reporting no physical key code is on-screen too.
    await keyboard(page, 844)
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).tap()
    await keys.waitFor()
    await input.evaluate((el) => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: '', keyCode: 13, bubbles: true, cancelable: true })) })
    await keys.waitFor({ state: 'detached' })
  } finally {
    try { await terminate(page, endpoint, headers, id) } finally { await browser.close() }
  }
}, 60000)

browserTest('ownership changes and reconnects release the modifiers and disable the sending keys', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  page.setDefaultTimeout(10000)
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  const headers = { 'X-Bakin-Terminal-Client': 'mobile-ownership-test' }
  let id: string | undefined
  const socket = await viewerSocket(page)
  await fakeViewport(page, 390, 844)
  const typing = async () => { await page.locator('.xterm-helper-textarea').focus(); await page.locator('.terminal-key-bar').waitFor() }
  const sendingEnabled = (enabled: boolean) => page.waitForFunction((enabled) => {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('.terminal-key-bar button')].find(button => button.getAttribute('aria-label') === 'Tab')
    return tab !== undefined && tab.disabled === !enabled
  }, enabled)
  const ctrlState = () => page.locator('.terminal-key-bar button[aria-label^="Control"]').getAttribute('data-state')
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Ownership keys', cwd: '/tmp', agentId: 'patch' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' })
    await typing()
    await sendingEnabled(true)
    await page.locator('.terminal-key-bar button[aria-label^="Control"]').tap()
    expect(await ctrlState()).toBe('once')
    await page.request.post(endpoint, { headers, data: { id, operation: 'return' } })
    await sendingEnabled(false)
    expect(await ctrlState()).toBe('off')
    // Hide keyboard stays usable while watching.
    expect(await page.getByRole('button', { name: 'Hide keyboard', exact: true }).isDisabled()).toBe(false)
    const before = socket.inputs().length
    await page.getByRole('button', { name: 'Tab', exact: true }).evaluate((el: HTMLButtonElement) => el.click())
    expect(socket.inputs().length).toBe(before)
    await page.getByRole('button', { name: 'Take over', exact: true }).filter({ visible: true }).click()
    // The header took focus (the keyboard went down with it): back to the terminal.
    await typing()
    await sendingEnabled(true)
    await page.locator('.terminal-key-bar button[aria-label^="Control"]').tap()
    expect(await ctrlState()).toBe('once')
    socket.block(true)
    const actions = page.getByRole('button', { name: 'Session actions', exact: true }).filter({ visible: true })
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await typing()
    await sendingEnabled(false)
    expect(await ctrlState()).toBe('off')
    socket.block(false)
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await typing()
    await sendingEnabled(true)
    await page.getByRole('button', { name: 'Tab', exact: true }).tap()
    await socket.waitFor((frame) => frame.type === 'input' && frame.data === '\t')
    expect(socket.inputs().length).toBe(before + 1)
  } finally {
    try { await terminate(page, endpoint, headers, id) } finally { await browser.close() }
  }
}, 60000)

browserTest('a desktop never shows the key bar', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(10000)
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  const headers = { 'X-Bakin-Terminal-Client': 'desktop-keys-test' }
  let id: string | undefined
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Desktop keys', cwd: '/tmp' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' })
    await page.locator('.xterm-helper-textarea').focus()
    await page.waitForTimeout(300)
    expect(await page.getByRole('group', { name: 'Terminal keys' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Show keyboard' }).count()).toBe(0)
  } finally {
    try { await terminate(page, endpoint, headers, id) } finally { await browser.close() }
  }
}, 30000)
