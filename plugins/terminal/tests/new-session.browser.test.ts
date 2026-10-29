import { expect } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    expect(await dialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue()).toBe('Shell · bakin · Patch')
    await dialog.getByRole('combobox', { name: 'Assigned agent' }).click()
    expect(await page.getByRole('option', { name: 'Chef (access disabled)', exact: true }).getAttribute('aria-disabled')).toBe('true')
    await page.keyboard.press('Escape')
    await directory.fill('/manual/path')
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('My terminal')
    await dialog.getByRole('combobox', { name: 'Task', exact: true }).click()
    await page.getByRole('option', { name: 'Terminal development', exact: true }).click()
    expect(await dialog.getByRole('combobox', { name: 'Project', exact: true }).textContent()).toContain('Bakin')
    expect(await directory.inputValue()).toBe('/manual/path')
    expect(await dialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue()).toBe('My terminal')
    await page.screenshot({ path: join(screenshots, 'new-terminal-desktop.png') })
    await page.setViewportSize({ width: 320, height: 740 })
    await page.screenshot({ path: join(screenshots, 'new-terminal-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('')
    expect(await dialog.getByRole('button', { name: 'Start terminal', exact: true }).isDisabled()).toBe(true)
  } finally { await browser.close() }
}, 30000)

browserTest('the folder picker browses this machine\'s folders and fills the working directory (or keeps what was typed)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bakin-terminal-picker-')))
  for (const name of ['alpha', 'beta/inner', '.secret']) mkdirSync(join(root, name), { recursive: true })
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } })
  const screenshots = join(import.meta.dir, '../test-results/live')
  mkdirSync(screenshots, { recursive: true })
  try {
    await page.route('**/api/plugins/terminal/options', (route) => route.fulfill({ json: { agents: [], tasks: [], defaults: { cwd: root, agentId: '' } } }))
    await page.route('**/api/plugins/projects/', (route) => route.fulfill({ json: { projects: [] } }))
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal' }).first().click()
    const dialog = page.getByRole('dialog')
    const directory = dialog.getByRole('textbox', { name: 'Working directory' })
    await page.waitForFunction((value) => [...document.querySelectorAll('input')].some((input) => input.value === value), root)
    await dialog.getByRole('button', { name: 'Browse…' }).click()
    await dialog.getByRole('heading', { name: 'Choose a folder' }).waitFor()
    const folders = dialog.getByRole('list', { name: 'Folders' })
    await folders.getByRole('button', { name: 'Open alpha' }).waitFor()
    await folders.getByRole('button', { name: 'Open beta' }).waitFor()
    expect(await folders.getByRole('button').count()).toBe(2)
    expect(await folders.getByRole('button', { name: 'Open .secret' }).count()).toBe(0)
    await page.screenshot({ path: join(screenshots, 'folder-picker-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    // Hidden folders only when asked; the filter narrows.
    await dialog.getByRole('switch', { name: 'Show hidden folders' }).click()
    await folders.getByRole('button', { name: 'Open .secret' }).waitFor()
    await dialog.getByRole('textbox', { name: 'Filter folders' }).fill('bet')
    await dialog.getByRole('list', { name: 'Folders' }).getByRole('button', { name: 'Open beta' }).waitFor()
    expect(await dialog.getByRole('list', { name: 'Folders' }).getByRole('button').count()).toBe(1)
    // In, up, in again, and use it.
    await dialog.getByRole('button', { name: 'Open beta' }).click()
    await dialog.getByText(join(root, 'beta'), { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Open inner' }).waitFor()
    await dialog.getByRole('button', { name: 'Up to the parent folder' }).click()
    await dialog.getByText(root, { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Open beta' }).click()
    await dialog.getByText(join(root, 'beta'), { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    await dialog.getByRole('heading', { name: 'New terminal' }).waitFor()
    expect(await directory.inputValue()).toBe(join(root, 'beta'))
    // A typed path that is not a folder: the picker says so and starts from home; Back keeps the typing.
    await directory.fill(join(root, 'missing'))
    await dialog.getByRole('button', { name: 'Browse…' }).click()
    await dialog.getByText(/missing does not exist/).waitFor()
    await dialog.getByRole('list', { name: 'Folders' }).waitFor()
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    expect(await directory.inputValue()).toBe(join(root, 'missing'))
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40000)
