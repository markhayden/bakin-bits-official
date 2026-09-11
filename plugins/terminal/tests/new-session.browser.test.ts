import { expect } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserTest, launchChromium } from './browser'

browserTest('new terminal populates choices, follows task links and preserves manual edits', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const screenshots = join(import.meta.dir, '../test-results/live')
  mkdirSync(screenshots, { recursive: true })
  try {
    await page.route('**/api/plugins/terminal/options', (route) => route.fulfill({ json: {
      agents: [{ id: 'patch', name: 'Patch', enabled: true, workspace: '/tmp' }, { id: 'chef', name: 'Chef', enabled: false }],
      tasks: [{ id: 'task-1', title: 'Terminal development', agentId: 'patch', projectId: 'project-1' }],
      defaults: { cwd: '/workspace/bakin', agentId: 'patch' },
    } }))
    await page.route('**/api/plugins/projects/', (route) => route.fulfill({ json: { projects: [{ id: 'project-1', title: 'Bakin' }] } }))
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal' }).first().click()
    const dialog = page.getByRole('dialog')
    const directory = dialog.getByRole('textbox', { name: 'Working directory' })
    await page.waitForFunction(() => [...document.querySelectorAll('input')].some((input) => input.value === '/workspace/bakin'))
    expect(await directory.inputValue()).toBe('/workspace/bakin')
    const agentField = dialog.getByRole('combobox', { name: 'Assigned agent' })
    expect((await agentField.boundingBox())!.width).toBeGreaterThanOrEqual((await directory.boundingBox())!.width - 1)
    expect(await dialog.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe('Shell - Patch')
    await dialog.getByRole('combobox', { name: 'Assigned agent' }).click()
    expect(await page.getByRole('option', { name: 'Chef (access disabled)', exact: true }).getAttribute('aria-disabled')).toBe('true')
    await page.keyboard.press('Escape')
    await directory.fill('/manual/path')
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('My terminal')
    await dialog.getByRole('combobox', { name: 'Task', exact: true }).click()
    await page.getByRole('option', { name: 'Terminal development', exact: true }).click()
    expect(await dialog.getByRole('combobox', { name: 'Project', exact: true }).textContent()).toContain('Bakin')
    expect(await directory.inputValue()).toBe('/manual/path')
    expect(await dialog.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe('My terminal')
    await page.screenshot({ path: join(screenshots, 'new-terminal-desktop.png') })
    await page.setViewportSize({ width: 320, height: 740 })
    await page.screenshot({ path: join(screenshots, 'new-terminal-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('')
    expect(await dialog.getByRole('button', { name: 'Start terminal', exact: true }).isDisabled()).toBe(true)
  } finally { await browser.close() }
}, 30000)
