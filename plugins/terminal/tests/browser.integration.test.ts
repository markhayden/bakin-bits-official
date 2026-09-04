import { expect, test } from 'bun:test'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const browserTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip
browserTest('browser creates a real shell, sends input and reconnects without losing output', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const screenshots = join(import.meta.dir, '../test-results/live')
  mkdirSync(screenshots, { recursive: true })
  try {
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal' }).first().click()
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Browser integration')
    await page.getByRole('textbox', { name: 'Working directory' }).fill('/tmp')
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click()
    await page.locator('.xterm-helper-textarea').waitFor()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf "BROWSER_%s_OK\\n" TERMINAL')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('BROWSER_TERMINAL_OK'), { timeout: 10000 })
    await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true })
    await page.getByRole('button', { name: 'Reconnect terminal', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('BROWSER_TERMINAL_OK'))
    await page.setViewportSize({ width: 320, height: 740 })
    await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Terminate and complete', exact: true }).click()
    await page.getByRole('button', { name: 'Terminate', exact: true }).click()
    await page.getByText('shell / completed', { exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 30000)
