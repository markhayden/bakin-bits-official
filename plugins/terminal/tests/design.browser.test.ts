import { expect } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserTest, launchChromium } from './browser'

browserTest('HTTP browsers load terminals and empty and error states own the full workspace', async () => {
  const browser = await launchChromium()
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
    expect(await page.getByRole('region', { name: 'No terminals yet', exact: true }).getAttribute('data-scope')).toBe('page')
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
    expect(await page.getByText(/Bakin installs tmux with this plugin/).count()).toBe(1)
    expect(await page.getByText(/bakin install plugin-assets/).count()).toBe(1)
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

browserTest('a screen that does not size the session fits the font to its width without resizing it', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  let resizes = 0
  const session = { id: 'agent-view', title: 'Agent-owned session', program: 'shell', state: 'running', cwd: '/tmp', createdAt: 1, generation: 1, revision: 1, inputSequence: 0, cols: 80, rows: 24, owner: { kind: 'agent', id: 'patch' } }
  try {
    await page.route('**/api/plugins/terminal/sessions', (route) => route.fulfill({ json: { serviceReady: true, sessions: [session] } }))
    await page.routeWebSocket('**/api/plugins/terminal/socket**', (socket) => socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type: string }
      if (frame.type === 'resize') resizes++
      if (frame.type === 'hello') socket.send(JSON.stringify({ type: 'sync', epoch: 1, cursor: 0, session, snapshot: btoa('$ agent work\r\n') }))
    }))
    await page.goto(new URL('/terminal/agent-view', process.env.TERMINAL_PREVIEW_URL!).href)
    await page.locator('.terminal-xterm .xterm').waitFor()
    await page.setViewportSize({ width: 1000, height: 740 })
    await page.waitForTimeout(250)
    // The real 80×24 grid, its font fitted to the pane's width; height pans.
    // Cells snap to whole pixels, so the fill is within a pixel per column.
    const pane = await page.getByRole('region', { name: 'Terminal output', exact: true }).boundingBox()
    await page.waitForFunction(() => document.querySelector('.xterm-screen')!.clientWidth > document.querySelector<HTMLElement>('.terminal-pane')!.clientWidth - 32 - 80)
    const grid = (await page.locator('.terminal-xterm .xterm-screen').boundingBox())!
    expect(grid.width).toBeLessThanOrEqual(pane!.width - 32)
    expect(resizes).toBe(0)
  } finally { await browser.close() }
}, 15000)

browserTest('immersive terminals use the full workspace and retain compact navigation and details', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  page.setDefaultTimeout(5000)
  // Running so the default Active view lists it on every navigation back.
  const session = { id: 'design-session', title: 'Review the terminal plugin implementation and retained development work', program: 'shell', state: 'running', cwd: '/workspace/bakin', createdAt: 1, lastActivityAt: 1, generation: 1, revision: 1, inputSequence: 0, cols: 80, rows: 24, owner: { kind: 'human', id: 'design-fixture-client' } }
  try {
    await page.route('**/api/plugins/terminal/sessions', (route) => route.fulfill({ json: { serviceReady: true, sessions: [session] } }))
    await page.routeWebSocket('**/api/plugins/terminal/socket**', (socket) => socket.onMessage((message) => {
      if ((JSON.parse(String(message)) as { type: string }).type === 'hello') socket.send(JSON.stringify({ type: 'sync', epoch: 1, cursor: 0, session, snapshot: btoa('$ git status\r\nWorking tree clean\r\n') }))
    }))
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('table', { name: 'Terminal sessions', exact: true }).waitFor()
    expect(await page.getByRole('columnheader').allTextContents()).toEqual(['Session', 'Program', 'Agent', 'Status', 'Last activity', 'Working directory', 'Actions'])
    await page.getByRole('tablist', { name: 'Session view', exact: true }).getByRole('tab', { name: 'Active', exact: true }).waitFor()
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/index-desktop.png') })
    await page.getByRole('link', { name: `Open terminal: ${session.title}`, exact: true }).click()
    await page.waitForURL(`**/terminal/${session.id}`)
    const workspace = page.locator('[data-archetype="workspace"]')
    expect(await workspace.getAttribute('data-mode')).toBe('immersive')
    expect(await page.getByRole('complementary', { name: 'Terminal sessions' }).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: 'Terminal session', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'New terminal', exact: true }).count()).toBe(0)
    await page.getByRole('region', { name: 'Terminal output', exact: true }).waitFor()
    const width = await workspace.evaluate((element) => element.clientWidth)
    const output = await page.getByRole('region', { name: 'Terminal output', exact: true }).boundingBox()
    expect(output!.width).toBeGreaterThan(width * 0.95)
    // Nobody sized this fixture session: the grid's font fills the width, inside the inset.
    const surface = await page.locator('.terminal-xterm .xterm').boundingBox()
    expect(surface!.width).toBeGreaterThan(output!.width - 32 - 80)
    expect(surface!.x - output!.x).toBeGreaterThanOrEqual(16)
    expect(surface!.y - output!.y).toBeGreaterThanOrEqual(16)
    expect(await page.getByRole('region', { name: 'Terminal output', exact: true }).evaluate((region) => getComputedStyle(region).backgroundColor === getComputedStyle(region.querySelector('.xterm-scrollable-element')!).backgroundColor)).toBe(true)
    expect(await page.getByRole('region', { name: 'Terminal output', exact: true }).evaluate((region) => getComputedStyle(region).backgroundColor === getComputedStyle(region.querySelector('.xterm-viewport')!).backgroundColor)).toBe(true)
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>('[data-archetype="workspace"]')
      if (!element) return false
      element.scrollTop = element.scrollHeight
      return Boolean(element.querySelector('[data-slot="workspace-page-compact-header"][data-stuck]'))
    })
    await page.locator('[data-slot="workspace-page-compact-header"][data-stuck]').waitFor()
    const header = page.locator('[data-slot="workspace-page-compact-header"][data-stuck]')
    const controls = header.getByLabel('Terminal controls', { exact: true })
    await controls.waitFor()
    const headerBox = await header.boundingBox()
    const controlsBox = await controls.boundingBox()
    expect(controlsBox!.y).toBeGreaterThanOrEqual(headerBox!.y)
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height)
    expect(controlsBox!.x).toBeGreaterThan(headerBox!.x + headerBox!.width / 2)
    const fittedOutput = await page.getByRole('region', { name: 'Terminal output', exact: true }).boundingBox()
    expect(fittedOutput!.y - (headerBox!.y + headerBox!.height)).toBeLessThanOrEqual(2)
    await header.getByRole('status').waitFor()
    expect(output!.height).toBeGreaterThan(700)
    expect(await page.getByRole('button', { name: 'Fit terminal to viewport', exact: true }).count()).toBe(0)
    for (const name of ['Session details', "You're driving", 'Interrupt process', 'Session actions']) {
      await controls.getByRole('button', { name, exact: true }).hover()
      await page.getByRole('tooltip').filter({ hasText: name }).waitFor()
      await page.mouse.move(0, 0)
      await page.getByRole('tooltip').waitFor({ state: 'hidden' })
    }
    await controls.getByRole('button', { name: 'Session details', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.getByRole('tooltip').filter({ hasText: "You're driving" }).waitFor()
    await page.keyboard.press('Escape')
    await controls.getByRole('button', { name: 'Session details', exact: true }).click()
    await page.getByRole('dialog', { name: 'Session details' }).getByText(session.cwd, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await controls.getByRole('button', { name: 'Session actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reconnect terminal', exact: true }).waitFor()
    await page.getByRole('menuitemcheckbox', { name: 'Capture Tab', exact: true }).waitFor()
    const menu = page.getByRole('menu', { name: 'Session actions', exact: true })
    expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(250)
    const singleLineLabels = () => menu.evaluate((element) => Array.from(element.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')).every((item) => {
      const text = Array.from(item.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
      if (!text) return false
      const range = document.createRange()
      range.selectNodeContents(text)
      return range.getClientRects().length === 1
    }))
    expect(await singleLineLabels()).toBe(true)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/actions-desktop.png'), animations: 'disabled' })
    expect(await page.getByRole('menuitem', { name: 'Terminate', exact: true }).isDisabled()).toBe(false)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/immersive-desktop.png') })
    await page.setViewportSize({ width: 320, height: 740 })
    const activity = page.getByTestId('mobile-live-activity-button')
    if (await activity.isVisible() && await activity.getAttribute('aria-pressed') === 'true') {
      await activity.click()
      await page.waitForFunction(() => (document.querySelector('[data-slot="activity-panel"]')?.getBoundingClientRect().width ?? 0) <= 1)
    }
    await page.getByRole('link', { name: 'Back to terminals', exact: true }).filter({ visible: true }).click()
    await page.waitForURL('**/terminal')
    await page.getByRole('table', { name: 'Terminal sessions', exact: true }).waitFor()
    await page.getByRole('link', { name: `Open terminal: ${session.title}`, exact: true }).waitFor()
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/index-mobile.png'), animations: 'disabled' })
    await page.getByRole('link', { name: `Open terminal: ${session.title}`, exact: true }).click()
    await page.waitForURL(`**/terminal/${session.id}`)
    await workspace.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.locator('[data-slot="workspace-page-compact-header"][data-stuck]').waitFor()
    await controls.waitFor()
    await controls.getByRole('button', { name: 'Session details', exact: true }).click()
    await page.getByRole('dialog', { name: 'Session details' }).getByRole('combobox', { name: 'Assigned agent', exact: true }).waitFor()
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/details-mobile.png'), animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Session details' }).waitFor({ state: 'hidden' })
    await page.getByRole('tooltip').filter({ hasText: 'Session details' }).waitFor()
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/tooltip-mobile.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await page.getByRole('tooltip').waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/immersive-mobile.png') })
    const mobileOutput = await page.getByRole('region', { name: 'Terminal output', exact: true }).boundingBox()
    expect(mobileOutput!.height).toBeGreaterThan(350)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await controls.getByRole('button', { name: 'Session actions', exact: true }).click()
    await menu.waitFor()
    expect(await singleLineLabels()).toBe(true)
    const menuBounds = await menu.boundingBox()
    expect(menuBounds!.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(320)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/actions-mobile.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
  } finally { await browser.close() }
}, 30000)


browserTest('service migration remains visible and explains why live sessions block setup', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } })
  try {
    await page.route('**/api/plugins/terminal/sessions', route => route.fulfill({ json: { sessions: [], serviceReady: true, serviceUpdateRequired: true } }))
    await page.route('**/api/plugins/terminal/service', route => route.fulfill({ status: 409, json: { error: "Terminal still has 2 live terminal panes. End them and press Set up service again to switch to Bakin's tmux." } }))
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByText('Terminal service update available', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Set up service', exact: true }).click()
    await page.getByText(/2 live terminal panes/).waitFor()
    expect(await page.getByText('Terminal service update available', { exact: true }).count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/design/migration-mobile.png') })
  } finally { await browser.close() }
}, 15000)
