import { expect, test } from 'bun:test'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const browserTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip
browserTest('browser creates a real shell, sends input and reconnects without losing output', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
  let createdId: string | undefined
  let completed = false
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const screenshots = join(import.meta.dir, '../test-results/live')
  mkdirSync(screenshots, { recursive: true })
  try {
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal' }).first().click()
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Browser integration')
    await page.getByRole('textbox', { name: 'Working directory' }).fill('/tmp')
    const creation = page.waitForResponse((response) => response.url().endsWith('/terminal/sessions') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click()
    createdId = (await (await creation).json()).id
    await page.locator('.xterm-helper-textarea').waitFor()
    const workspace = page.locator('[data-archetype="workspace"]')
    await workspace.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.locator('[data-slot="workspace-page-compact-header"][data-stuck]').waitFor()
    const resize = page.waitForResponse((response) => response.url().endsWith('/terminal/session') && response.request().postDataJSON()?.operation === 'resize')
    await page.getByRole('button', { name: 'Fit terminal to viewport', exact: true }).click()
    const fitted = await (await resize).json()
    expect(fitted.cols).toBeGreaterThan(80)
    expect(fitted.rows).toBeGreaterThan(24)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf "BROWSER_%s_OK\\n" TERMINAL')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('BROWSER_TERMINAL_OK'), { timeout: 10000 })
    await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true })
    await workspace.locator('[data-slot="workspace-page-compact-header"]').getByRole('link', { name: 'Back to terminals', exact: true }).click()
    await page.waitForURL('**/terminal')
    await page.locator(`a[href="/terminal/${createdId}"]`).click()
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('BROWSER_TERMINAL_OK'))
    await page.getByRole('button', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('BROWSER_TERMINAL_OK'))
    await page.getByText('Capture Tab', { exact: true }).click()
    expect(await page.getByRole('checkbox', { name: 'Capture Tab', exact: true }).isChecked()).toBe(true)
    await page.getByText('Capture Tab', { exact: true }).click()
    expect(await page.getByRole('checkbox', { name: 'Capture Tab', exact: true }).isChecked()).toBe(false)
    await page.setViewportSize({ width: 320, height: 740 })
    const closeActivity = page.getByTestId('mobile-live-activity-button')
    if (await closeActivity.isVisible() && await closeActivity.getAttribute('aria-pressed') === 'true') {
      await closeActivity.click()
      await page.waitForFunction(() => (document.querySelector('[data-slot="activity-panel"]')?.getBoundingClientRect().width ?? 0) <= 1)
    }
    await workspace.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const mobileResize = page.waitForResponse((response) => response.url().endsWith('/terminal/session') && response.request().postDataJSON()?.operation === 'resize')
    await page.getByRole('button', { name: 'Fit terminal to viewport', exact: true }).click()
    expect((await (await mobileResize).json()).cols).toBeLessThan(40)
    await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Session actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Terminate and complete', exact: true }).click()
    await page.getByRole('button', { name: 'Terminate', exact: true }).click()
    await page.getByRole('region', { name: 'Selected terminal' }).getByRole('status').filter({ hasText: 'Completed' }).waitFor()
    completed = true
    expect(errors).toEqual([])
  } finally {
    try { if (createdId && !completed) {
      const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
      const headers = { 'X-Bakin-Terminal-Client': 'browser-test-cleanup-client' }
      const taken = await page.request.post(endpoint, { headers, timeout: 5000, data: { id: createdId, operation: 'take' } })
      if (taken.ok()) {
        const session = await taken.json()
        if (session.state !== 'completed') await page.request.post(endpoint, { headers, timeout: 5000, data: { id: createdId, operation: 'terminate', generation: session.generation } })
      }
    } } finally { await browser.close() }
  }
}, 30000)
