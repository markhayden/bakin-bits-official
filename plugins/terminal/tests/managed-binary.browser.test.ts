import { expect } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserTest, launchChromium, viewerSocket } from './browser'

browserTest('managed tmux serves a real shell across reconnect, and the creating screen keeps sizing it', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const socket = await viewerSocket(page)
  let id: string | undefined
  try {
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Managed tmux release smoke')
    await page.getByRole('textbox', { name: 'Working directory' }).fill('/tmp')
    const creation = page.waitForResponse(response => response.url().endsWith('/terminal/sessions') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click()
    id = (await (await creation).json()).id
    // Typing before the viewer socket syncs is refused, never queued.
    await page.getByRole('status').filter({ hasText: "You're driving", visible: true }).first().waitFor()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf "MANAGED_%s_OK\\n" TMUX')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('MANAGED_TMUX_OK'))
    const controls = page.getByLabel('Terminal controls', { exact: true }).filter({ visible: true })
    await controls.getByRole('button', { name: 'Session actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('MANAGED_TMUX_OK'))
    // The creator holds the size claim, so narrowing its window narrows the session (to the 40-column floor at most).
    await page.setViewportSize({ width: 390, height: 844 })
    const resized = await socket.waitFor(frame => frame.type === 'resize' && (frame.cols as number) < 50)
    expect(resized.cols).toBeGreaterThanOrEqual(40)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const screenshots = join(import.meta.dir, '../test-results/release')
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'managed-shell-mobile.png') })
    expect(errors).toEqual([])
  } finally {
    try {
      if (id) {
        const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
        const headers = { 'X-Bakin-Terminal-Client': 'managed-tmux-release-smoke' }
        const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
        expect(taken.ok(), 'Could not take control for smoke-test cleanup').toBe(true)
        const session = await taken.json()
        const finished = await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
        expect(finished.ok()).toBe(true)
      }
    } finally { await browser.close() }
  }
}, 20000)
