import { expect, test } from 'bun:test'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const browserTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip
browserTest('HTTP browsers load terminals and empty and error states own the full workspace', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  const screenshots = join(import.meta.dir, '../test-results/design')
  mkdirSync(screenshots, { recursive: true })
  let unavailable = false
  let serviceReady = true
  let marker = ''
  try {
    await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }))
    await page.route('**/api/plugins/terminal/sessions', (route) => {
      marker = route.request().headers()['x-bakin-terminal-client'] ?? ''
      return route.fulfill(unavailable
        ? { status: 503, json: { error: 'Connection interrupted' } }
        : { json: { sessions: [], serviceReady } })
    })
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('heading', { name: 'No terminals yet', exact: true }).waitFor()
    expect(marker).toMatch(/^[a-zA-Z0-9-]{16,100}$/)
    expect(await page.getByRole('complementary', { name: 'Terminal sessions' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'New terminal', exact: true }).count()).toBe(1)
    expect(await page.locator('[data-slot="system-state"]').getAttribute('data-scope')).toBe('page')
    await page.screenshot({ path: join(screenshots, 'empty-desktop.png') })
    unavailable = true
    await page.reload()
    await page.getByRole('alert', { name: 'Terminals could not be loaded' }).waitFor()
    expect(await page.getByRole('button', { name: 'Set up service', exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(screenshots, 'error-desktop.png') })
    unavailable = false
    serviceReady = false
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('button', { name: 'Set up service', exact: true }).waitFor()
    expect(await page.getByText('Connection interrupted', { exact: true }).count()).toBe(0)
    await page.setViewportSize({ width: 320, height: 740 })
    const activity = page.getByTestId('mobile-live-activity-button')
    if (await activity.isVisible() && await activity.getAttribute('aria-pressed') === 'true') {
      await activity.click()
      await page.waitForFunction(() => (document.querySelector('[data-slot="activity-panel"]')?.getBoundingClientRect().width ?? 0) <= 1)
    }
    await page.screenshot({ path: join(screenshots, 'setup-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await browser.close() }
}, 30000)
