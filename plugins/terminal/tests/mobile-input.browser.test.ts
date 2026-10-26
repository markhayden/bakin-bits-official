import { expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserTest, launchChromium, viewerSocket } from './browser'

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
    const keys = page.getByRole('group', { name: 'Terminal keys', exact: true })
    const tab = keys.getByRole('button', { name: 'Tab', exact: true })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled === false)
    await tab.waitFor()
    // A session made over the API is nobody's size yet: this phone takes it, so the grid fits above the keys.
    await page.locator('[data-slot="workspace-page-compact-header"]').getByRole('button', { name: /^Terminal size / }).tap()
    await page.getByRole('button', { name: 'Fit to this device', exact: true }).tap()
    await page.waitForFunction(() => document.querySelector('.terminal-pane')?.getAttribute('data-fit') === 'pane')
    await page.keyboard.press('Escape')
    const input = page.locator('.xterm-helper-textarea')
    await input.focus()
    await page.keyboard.type('cat completion-pr')
    await tab.tap()
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await output('COMPLETION_OK')
    await keys.getByRole('button', { name: 'Up', exact: true }).tap()
    await page.keyboard.press('Enter')
    await output('COMPLETION_OK')
    // Keystrokes may coalesce into one envelope; the bytes and their order are what matter.
    await socket.waitForTyped('\t')
    expect(socket.typed().includes('\x1b[A') || socket.typed().includes('\x1bOA')).toBe(true)
    // A raw terminal application enables DECCKM and reads the actual cursor bytes.
    await page.keyboard.type("stty -icanon -echo; printf '\\033[?1hAPP_%s\\n' READY; dd bs=1 count=3 2>/dev/null | od -An -tx1; printf '\\033[?1l'; stty sane")
    await page.keyboard.press('Enter')
    await output('APP_READY')
    await keys.getByRole('button', { name: 'Up', exact: true }).tap()
    await output('1b 4f 41')
    await socket.waitForTyped('\x1bOA')
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap()
    await page.keyboard.type('c')
    await page.keyboard.type("printf 'AFTER_%s\\n' INTERRUPT")
    await page.keyboard.press('Enter')
    await output('AFTER_INTERRUPT')
    await socket.waitForTyped('\x03')
    expect(await keys.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed')).toBe('false')
    await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap()
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 350.5 })
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(() => (document.querySelector('[data-archetype="workspace"]')?.getBoundingClientRect().bottom ?? 999) < 352)
    expect(await keys.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap()
    await keys.getByRole('button', { name: 'More', exact: true }).tap()
    await keys.getByRole('button', { name: 'Shift+Tab', exact: true }).tap()
    await socket.waitForTyped('\x1b[Z')
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    // The pane sits above the keys inside the short viewport. Smaller than the
    // 40×10 floor, it keeps the floored grid and pans over it (spec D2).
    await page.waitForFunction(() => {
      const pane = document.querySelector<HTMLElement>('.terminal-pane')!
      const output = pane.getBoundingClientRect()
      const keys = document.querySelector('.terminal-input-controls')!.getBoundingClientRect()
      return output.bottom <= keys.top + 1 && keys.bottom <= 351.5 && pane.scrollHeight > pane.clientHeight
    })
    const images = join(import.meta.dir, '../test-results/mobile-input')
    mkdirSync(images, { recursive: true })
    await page.screenshot({ path: join(images, (process.env.TERMINAL_BROWSER ?? 'chromium') + '-keyboard-open.png') })
    // Pasting/composing must consume the latch without applying it to text.
    await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap()
    await input.dispatchEvent('compositionstart')
    expect(await keys.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed')).toBe('false')
    await input.dispatchEvent('compositionend')
    await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap()
    await input.dispatchEvent('paste')
    expect(await keys.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(errors).toEqual([])
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
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Ownership keys', cwd: '/tmp', agentId: 'patch' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled === false)
    await ctrl.tap()
    await page.request.post(endpoint, { headers, data: { id, operation: 'return' } })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled && document.querySelector('.terminal-input-controls button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    const before = socket.inputs().length
    await page.getByRole('button', { name: 'Tab', exact: true }).evaluate((el: HTMLButtonElement) => el.click())
    expect(socket.inputs().length).toBe(before)
    await page.getByRole('button', { name: 'Take over', exact: true }).filter({ visible: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled === false)
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    await ctrl.tap()
    socket.block(true)
    const actions = page.getByRole('button', { name: 'Session actions', exact: true }).filter({ visible: true })
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled && document.querySelector('.terminal-input-controls button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    socket.block(false)
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled === false)
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
