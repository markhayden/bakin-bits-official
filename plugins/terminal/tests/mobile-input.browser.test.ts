import { expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserTest, launchChromium } from './browser'

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
  const writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (request.url() === endpoint && request.method() === 'POST') {
      const data = request.postDataJSON()
      if (data?.operation === 'write') writes.push(data.data)
    }
  })
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
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled)
    await tab.waitFor()
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
    expect(writes).toContain('\t')
    expect(writes.some(data => data === '\x1b[A' || data === '\x1bOA')).toBe(true)
    // A raw terminal application enables DECCKM and reads the actual cursor bytes.
    await page.keyboard.type("stty -icanon -echo; printf '\\033[?1hAPP_%s\\n' READY; dd bs=1 count=3 2>/dev/null | od -An -tx1; printf '\\033[?1l'; stty sane")
    await page.keyboard.press('Enter')
    await output('APP_READY')
    await keys.getByRole('button', { name: 'Up', exact: true }).tap()
    await output('1b 4f 41')
    expect(writes).toContain('\x1bOA')
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap()
    await page.keyboard.type('c')
    await page.keyboard.type("printf 'AFTER_%s\\n' INTERRUPT")
    await page.keyboard.press('Enter')
    await output('AFTER_INTERRUPT')
    expect(writes).toContain('\x03')
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
    expect(writes).toContain('\x1b[Z')
    expect(await input.evaluate(el => el === document.activeElement)).toBe(true)
    await page.waitForFunction(() => {
      const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect()
      const output = document.querySelector('.terminal-xterm')!.getBoundingClientRect()
      const keys = document.querySelector('.terminal-input-controls')!.getBoundingClientRect()
      return screen.height <= output.height + 1 && output.bottom <= keys.top + 1 && keys.bottom <= 351.5
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
  const writes: unknown[] = []
  page.on('request', request => {
    if (request.url() === endpoint && request.method() === 'POST' && request.postDataJSON()?.operation === 'write') writes.push(request.postDataJSON())
  })
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Ownership keys', cwd: '/tmp', agentId: 'patch' } })
    id = (await created.json()).id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled)
    await ctrl.tap()
    await page.request.post(endpoint, { headers, data: { id, operation: 'return' } })
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled && document.querySelector('.terminal-input-controls button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    const before = writes.length
    await page.getByRole('button', { name: 'Tab', exact: true }).evaluate((el: HTMLButtonElement) => el.click())
    expect(writes.length).toBe(before)
    await page.getByRole('button', { name: 'Take over', exact: true }).filter({ visible: true }).click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled)
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    await ctrl.tap()
    await page.route('**/api/plugins/terminal/stream?**', route => route.abort())
    const actions = page.getByRole('button', { name: 'Session actions', exact: true }).filter({ visible: true })
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled && document.querySelector('.terminal-input-controls button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    expect(await ctrl.getAttribute('aria-pressed')).toBe('false')
    await page.unroute('**/api/plugins/terminal/stream?**')
    await actions.click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.terminal-input-controls button')?.disabled)
    const sent = page.waitForResponse(response => response.url() === endpoint && response.request().postDataJSON()?.operation === 'write')
    await page.getByRole('button', { name: 'Tab', exact: true }).tap()
    await sent
    expect(writes.length).toBe(before + 1)
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
