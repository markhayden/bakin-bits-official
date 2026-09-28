import { expect } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserTest, launchChromium } from './browser'

browserTest('managed tmux serves a real shell across reconnect and mobile resizing', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let id: string | undefined
  try {
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Managed tmux release smoke')
    await page.getByRole('textbox', { name: 'Working directory' }).fill('/tmp')
    const creation = page.waitForResponse(response => response.url().endsWith('/terminal/sessions') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click()
    id = (await (await creation).json()).id
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf "MANAGED_%s_OK\\n" TMUX')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('MANAGED_TMUX_OK'))
    const controls = page.getByLabel('Terminal controls', { exact: true }).filter({ visible: true })
    await controls.getByRole('button', { name: 'Session actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('MANAGED_TMUX_OK'))
    const resized = page.waitForResponse(response => response.url().endsWith('/terminal/session') && response.request().postDataJSON()?.operation === 'resize' && response.request().postDataJSON()?.cols < 50)
    await page.setViewportSize({ width: 390, height: 844 })
    expect((await (await resized).json()).cols).toBeLessThan(50)
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
        if (!taken.ok()) throw new Error('Could not take control for smoke-test cleanup')
        const session = await taken.json()
        const finished = await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
        expect(finished.ok()).toBe(true)
      }
    } finally { await browser.close() }
  }
}, 20000)
