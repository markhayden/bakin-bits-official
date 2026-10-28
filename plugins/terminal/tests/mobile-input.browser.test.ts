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

browserTest('phone keys drive completion, history and interrupt while preserving focus and short viewport geometry', async () => {
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
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 800, width: 320, offsetTop: 0, offsetLeft: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  })
  const output = async (text: string) => page.waitForFunction(text => document.querySelector('.xterm-accessibility-tree')?.textContent?.replace(/\s+/g, ' ').includes(text), text)
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
    // Keyboard down: no key bar, just the corner keyboard button, which focuses the terminal.
    const keys = page.getByRole('toolbar', { name: 'Terminal keys', exact: true })
    expect(await keys.count()).toBe(0)
    const input = page.locator('.xterm-helper-textarea')
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).tap()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    // The keyboard slides up (the visual viewport shrinks): the bar appears above it and the button goes.
    await keyboard(page, 450)
    await keys.waitFor()
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).waitFor({ state: 'detached' })
    const strip = keys.locator('.terminal-key-strip')
    const tab = strip.getByRole('button', { name: 'Tab', exact: true })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled === false)
    await page.keyboard.type('cat completion-pr')
    await tab.tap()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await output('COMPLETION_OK')
    await strip.getByRole('button', { name: 'Up', exact: true }).tap()
    await page.keyboard.press('Enter')
    await output('COMPLETION_OK')
    // Keystrokes may coalesce into one envelope; the bytes and their order are what matter.
    await socket.waitForTyped('\t')
    expect(socket.typed().includes('\x1b[A') || socket.typed().includes('\x1bOA')).toBe(true)
    // A raw terminal application enables DECCKM and reads the actual cursor bytes.
    await page.keyboard.type("stty -icanon -echo; printf '\\033[?1hAPP_%s\\n' READY; dd bs=1 count=3 2>/dev/null | od -An -tx1; printf '\\033[?1l'; stty sane")
    await page.keyboard.press('Enter')
    await output('APP_READY')
    await strip.getByRole('button', { name: 'Up', exact: true }).tap()
    await output('1b 4f 41')
    await socket.waitForTyped('\x1bOA')
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    const ctrl = strip.getByRole('button', { name: 'Ctrl', exact: true })
    await ctrl.tap()
    await page.keyboard.type('c')
    await page.keyboard.type("printf 'AFTER_%s\\n' INTERRUPT")
    await page.keyboard.press('Enter')
    await output('AFTER_INTERRUPT')
    await socket.waitForTyped('\x03')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    // A pinned key sends at once; ^C is pinned by default.
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    const interrupts = socket.typed().split('\x03').length
    await strip.getByRole('button', { name: 'Ctrl+C', exact: true }).tap()
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('^C'))
    expect(socket.typed().split('\x03').length).toBe(interrupts + 1)
    // The keyboard getting taller (a predictive row): Ctrl survives, and the bar stays put above it.
    await ctrl.tap()
    await keyboard(page, 350.5)
    await page.waitForFunction(() => (document.querySelector('[data-archetype="workspace"]')?.getBoundingClientRect().bottom ?? 999) < 352)
    expect(await ctrl.getAttribute('aria-pressed')).toBe('true')
    // ••• keeps the keyboard up and the latch; a press outside closes it without sending.
    const more = keys.getByRole('button', { name: 'More keys', exact: true })
    await more.tap()
    const menu = page.getByRole('dialog', { name: 'More keys' })
    await menu.waitFor()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    expect(await ctrl.getAttribute('aria-pressed')).toBe('true')
    const typedBeforeMenu = socket.typed()
    await ctrl.tap()
    await menu.waitFor({ state: 'detached' })
    expect(socket.typed()).toBe(typedBeforeMenu)
    // A menu key sends once and closes the menu.
    await more.tap()
    await menu.getByRole('region', { name: 'Keys' }).getByRole('button', { name: 'Shift+Tab', exact: true }).tap()
    await socket.waitForTyped('\x1b[Z')
    await menu.waitFor({ state: 'detached' })
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await keys.getByRole('button', { name: 'More keys', exact: true }).tap()
    await page.getByRole('dialog', { name: 'More keys' }).getByRole('button', { name: 'Ctrl+L Clear screen', exact: true }).tap()
    await socket.waitForTyped('\x0c')
    // The pane sits above the keys inside the short viewport.
    await page.waitForFunction(() => {
      const output = document.querySelector<HTMLElement>('.terminal-pane')!.getBoundingClientRect()
      const keys = document.querySelector('.terminal-key-bar')!.getBoundingClientRect()
      return output.bottom <= keys.top + 1 && keys.bottom <= 351.5
    })
    // Shorter still (landscape): smaller than the 40×10 floor, the pane keeps
    // the floored grid and pans over it (spec D2), the bar still above the keyboard.
    await keyboard(page, 250.5)
    await page.waitForFunction(() => {
      const pane = document.querySelector<HTMLElement>('.terminal-pane')!
      const output = pane.getBoundingClientRect()
      const keys = document.querySelector('.terminal-key-bar')!.getBoundingClientRect()
      return output.bottom <= keys.top + 1 && keys.bottom <= 251.5 && pane.scrollHeight > pane.clientHeight
    })
    const images = join(import.meta.dir, '../test-results/mobile-input')
    mkdirSync(images, { recursive: true })
    await page.screenshot({ path: join(images, (process.env.TERMINAL_BROWSER ?? 'chromium') + '-keyboard-open.png') })
    // Pasting/composing must consume the latch without applying it to text.
    await ctrl.tap()
    await input.dispatchEvent('compositionstart')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    await input.dispatchEvent('compositionend')
    await ctrl.tap()
    await input.dispatchEvent('paste')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    // The keyboard going down takes the bar with it; the corner button returns.
    await keyboard(page, 800)
    await keys.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Show keyboard', exact: true }).waitFor()
    // WebKit reports a deferred ResizeObserver delivery (a notice, not an
    // exception) at the 250 px step of this sequence only; it does not
    // reproduce outside it. Tracked for the physical-iPhone checkpoint.
    expect(errors.filter(message => message !== 'ResizeObserver loop completed with undelivered notifications.')).toEqual([])
  } finally {
    try {
      if (id) {
        const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
        const session = await taken.json()
        await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
      }
    } finally { await browser.close(); rmSync(root, { recursive: true, force: true }) }
  }
}, 60000)

browserTest('ownership changes and reconnects discard Ctrl and disable stale key actions', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  page.setDefaultTimeout(10000)
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  const headers = { 'X-Bakin-Terminal-Client': 'mobile-ownership-test' }
  let id: string | undefined
  const socket = await viewerSocket(page)
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  })
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Ownership keys', cwd: '/tmp', agentId: 'patch' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    await page.locator('.xterm-helper-textarea').waitFor()
    await page.locator('.xterm-helper-textarea').focus()
    await keyboard(page, 500)
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled === false)
    await ctrl.tap()
    await page.request.post(endpoint, { headers, data: { id, operation: 'return' } })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled && document.querySelector('.terminal-key-bar button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    const before = socket.inputs().length
    await page.getByRole('button', { name: 'Tab', exact: true }).evaluate((el: HTMLButtonElement) => el.click())
    expect(socket.inputs().length).toBe(before)
    await page.getByRole('button', { name: 'Take over', exact: true }).filter({ visible: true }).click()
    // The header took focus (the keyboard went down with it): back to the terminal.
    await page.locator('.xterm-helper-textarea').focus()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled === false)
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    await ctrl.tap()
    socket.block(true)
    const actions = page.getByRole('button', { name: 'Session actions', exact: true }).filter({ visible: true })
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled && document.querySelector('.terminal-key-bar button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    socket.block(false)
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-key-bar button')?.disabled === false)
    await page.getByRole('button', { name: 'Tab', exact: true }).tap()
    await socket.waitFor((frame) => frame.type === 'input' && frame.data === '\t')
    expect(socket.inputs().length).toBe(before + 1)
  } finally {
    try {
      if (id) {
        const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
        const session = await taken.json()
        await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
      }
    } finally { await browser.close() }
  }
}, 45000)

browserTest('a desktop never shows the key bar, even with its viewport shrunk', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(10000)
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  const headers = { 'X-Bakin-Terminal-Client': 'desktop-keys-test' }
  let id: string | undefined
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 800, width: 1280, offsetTop: 0, offsetLeft: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  })
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Desktop keys', cwd: '/tmp' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    await page.locator('.xterm-helper-textarea').waitFor()
    await page.locator('.xterm-helper-textarea').focus()
    await keyboard(page, 400)
    await page.waitForTimeout(300)
    expect(await page.getByRole('toolbar', { name: 'Terminal keys' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Show keyboard' }).count()).toBe(0)
  } finally {
    try {
      if (id) {
        const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
        const session = await taken.json()
        await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
      }
    } finally { await browser.close() }
  }
}, 30000)
