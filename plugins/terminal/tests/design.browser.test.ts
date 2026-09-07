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

browserTest('immersive terminals use the full workspace and retain compact navigation and details', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  page.setDefaultTimeout(5000)
  const session = { id: 'design-session', title: 'Review the terminal plugin implementation and retained development work', program: 'shell', state: 'completed', cwd: '/workspace/bakin', createdAt: 1, generation: 1, revision: 1, inputSequence: 0, cols: 80, rows: 24, owner: { kind: 'human', id: 'design-fixture-client' } }
  try {
    await page.route('**/api/plugins/terminal/sessions', (route) => route.fulfill({ json: { serviceReady: true, sessions: [session] } }))
    await page.route('**/api/plugins/terminal/stream?*', (route) => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'output', session, cursor: 0, data: btoa('$ git status\r\nWorking tree clean\r\n') })}\n\n` }))
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('link', { name: `Open terminal: ${session.title}`, exact: true }).click()
    await page.waitForURL(`**/terminal/${session.id}`)
    const workspace = page.locator('[data-archetype="workspace"]')
    expect(await workspace.getAttribute('data-mode')).toBe('immersive')
    expect(await page.getByRole('complementary', { name: 'Terminal sessions' }).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: 'Terminal session', exact: true }).count()).toBe(0)
    await page.getByRole('region', { name: 'Terminal output', exact: true }).waitFor()
    const width = await workspace.evaluate((element) => element.clientWidth)
    const output = await page.getByRole('region', { name: 'Terminal output', exact: true }).boundingBox()
    expect(output!.width).toBeGreaterThan(width * 0.95)
    await workspace.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.locator('[data-slot="workspace-page-compact-header"][data-stuck]').waitFor()
    expect(output!.height).toBeGreaterThan(700)
    for (const name of ['Session details', 'Take control', 'Return control to agent', 'Interrupt process', 'Session actions', 'Fit terminal to viewport', 'Reconnect terminal']) {
      await page.getByRole('button', { name, exact: true }).hover()
      await page.getByRole('tooltip').filter({ hasText: name }).waitFor()
      await page.mouse.move(0, 0)
      await page.getByRole('tooltip').waitFor({ state: 'hidden' })
    }
    await page.getByRole('button', { name: 'Session details', exact: true }).click()
    await page.getByRole('dialog', { name: 'Session details' }).getByText(session.cwd, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Session actions', exact: true }).click()
    expect(await page.getByRole('menuitem', { name: 'Terminate and complete', exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/immersive-desktop.png') })
    await page.setViewportSize({ width: 320, height: 740 })
    const activity = page.getByTestId('mobile-live-activity-button')
    if (await activity.isVisible() && await activity.getAttribute('aria-pressed') === 'true') await activity.click()
    await page.getByRole('link', { name: 'Back to terminals', exact: true }).filter({ visible: true }).click()
    await page.waitForURL('**/terminal')
    await page.getByRole('link', { name: `Open terminal: ${session.title}`, exact: true }).waitFor()
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/index-mobile.png') })
    await page.getByRole('link', { name: `Open terminal: ${session.title}`, exact: true }).click()
    await page.waitForURL(`**/terminal/${session.id}`)
    await workspace.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.locator('[data-slot="workspace-page-compact-header"][data-stuck]').waitFor()
    await page.getByRole('button', { name: 'Session details', exact: true }).click()
    await page.getByRole('dialog', { name: 'Session details' }).getByRole('combobox', { name: 'Assigned agent', exact: true }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Session details' }).waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/immersive-mobile.png') })
    const mobileOutput = await page.getByRole('region', { name: 'Terminal output', exact: true }).boundingBox()
    expect(mobileOutput!.height).toBeGreaterThan(350)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await browser.close() }
}, 30000)
