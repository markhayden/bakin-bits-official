import { expect, test } from 'bun:test'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const browserTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip
browserTest('table fits long paths and row actions preserve navigation, target identity, and confirmation', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(5000)
  const screenshots = join(import.meta.dir, '../test-results/design')
  mkdirSync(screenshots, { recursive: true })
  const base = { program: 'shell', cwd: `/workspace/${'long-directory-'.repeat(20)}`, createdAt: 1, generation: 3, revision: 1, inputSequence: 0, cols: 80, rows: 24 }
  const sessions = [
    { ...base, id: 'alpha', title: 'Alpha completed', state: 'completed', owner: { kind: 'human', id: 'another-browser' }, historyDeleted: false },
    { ...base, id: 'beta', title: 'Beta exited', state: 'exited', owner: { kind: 'human', id: '' }, historyDeleted: false },
    { ...base, id: 'gamma', title: 'Gamma agent-owned', state: 'running', owner: { kind: 'agent', id: 'patch' }, historyDeleted: false },
  ]
  const operations: { id: string; operation: string; generation: number }[] = []
  let failDelete = true
  try {
    await page.route('**/api/plugins/terminal/sessions', (route) => {
      sessions[1]!.owner.id = route.request().headers()['x-bakin-terminal-client']!
      return route.fulfill({ json: { serviceReady: true, sessions } })
    })
    await page.route('**/api/plugins/terminal/session', (route) => {
      const request = route.request().postDataJSON()
      operations.push(request)
      if (failDelete && request.operation === 'delete-history') return route.fulfill({ status: 503, json: { error: 'Output cleanup unavailable' } })
      const session = sessions.find((item) => item.id === request.id)!
      session.revision++
      if (request.operation === 'complete' || request.operation === 'terminate') session.state = 'completed'
      if (request.operation === 'take') { session.owner = { kind: 'human', id: route.request().headers()['x-bakin-terminal-client']! }; session.generation++ }
      if (request.operation === 'delete-history') session.historyDeleted = true
      return route.fulfill({ json: session })
    })
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    const table = page.getByRole('table', { name: 'Terminal sessions', exact: true })
    await table.waitFor()
    expect(await table.evaluate((element) => element.parentElement!.scrollWidth <= element.parentElement!.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshots, 'index-fit-desktop.png'), animations: 'disabled' })
    const openAlpha = page.getByRole('button', { name: 'Actions for Alpha completed', exact: true })
    await openAlpha.hover()
    await page.getByRole('tooltip').filter({ hasText: 'Actions for Alpha completed' }).waitFor()
    await openAlpha.click()
    expect(new URL(page.url()).pathname).toBe('/terminal')
    expect(await page.getByRole('menuitem', { name: 'Complete session', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('menuitem', { name: 'Delete completed output', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete output history?' }).getByText(/Alpha completed/).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(operations).toHaveLength(0)
    await page.getByRole('button', { name: 'Actions for Beta exited', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Complete session', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('table')?.textContent?.includes('Beta exited') && Array.from(document.querySelectorAll('table [data-slot="badge"]')).filter((e) => e.textContent === 'Completed').length === 2)
    expect(operations[0]).toMatchObject({ id: 'beta', operation: 'complete', generation: 3 })
    expect(new URL(page.url()).pathname).toBe('/terminal')
    await openAlpha.click()
    await page.getByRole('menuitem', { name: 'Delete completed output', exact: true }).click()
    await page.getByRole('button', { name: 'Delete output', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Output cleanup unavailable' }).waitFor()
    await page.getByRole('dialog', { name: 'Delete output history?' }).waitFor()
    failDelete = false
    await page.getByRole('button', { name: 'Delete output', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete output history?' }).waitFor({ state: 'hidden' })
    expect(operations.slice(1).every((item) => item.id === 'alpha' && item.operation === 'delete-history')).toBe(true)
    await openAlpha.click()
    expect(await page.getByRole('menuitem', { name: 'Delete completed output', exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    const openGamma = page.getByRole('button', { name: 'Actions for Gamma agent-owned', exact: true })
    await openGamma.click()
    expect(await page.getByRole('menuitem', { name: 'Terminate and complete', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('menuitem', { name: 'Take control', exact: true }).click()
    await openGamma.click()
    await page.getByRole('menuitem', { name: 'Terminate and complete', exact: true }).click()
    await page.getByRole('dialog', { name: 'Terminate this session?' }).getByText(/Gamma agent-owned/).waitFor()
    await page.getByRole('button', { name: 'Terminate', exact: true }).click()
    await page.getByRole('dialog', { name: 'Terminate this session?' }).waitFor({ state: 'hidden' })
    expect(operations.at(-1)).toMatchObject({ id: 'gamma', operation: 'terminate', generation: 4 })
    await page.setViewportSize({ width: 320, height: 740 })
    const activity = page.getByTestId('mobile-live-activity-button')
    if (await activity.isVisible() && await activity.getAttribute('aria-pressed') === 'true') await activity.click()
    await openAlpha.click()
    await page.getByRole('menu').waitFor()
    await page.waitForFunction(() => Boolean(document.querySelector('[role="menu"]:not([data-starting-style])')))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, 'index-actions-mobile.png'), animations: 'disabled' })
  } finally { await browser.close() }
}, 30000)
