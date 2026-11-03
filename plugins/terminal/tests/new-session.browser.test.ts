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
    // One steady size while browsing: navigating never resizes the dialog, and the list scrolls inside it.
    const sized = async () => { const box = (await page.getByRole('dialog').boundingBox())!; return [Math.round(box.width), Math.round(box.height)] }
    const before = await sized()
    await dialog.getByRole('button', { name: 'Open beta' }).click()
    await dialog.getByText(`Uses ${join(root, 'beta')}`).waitFor()
    expect(await sized()).toEqual(before)
    await dialog.getByRole('button', { name: 'Up to the parent folder' }).click()
    await dialog.getByText(`Uses ${root}`).waitFor()
    // Hidden folders only when asked; the filter narrows.
    await dialog.getByRole('switch', { name: 'Show hidden folders' }).click()
    await folders.getByRole('button', { name: 'Open .secret' }).waitFor()
    await dialog.getByRole('textbox', { name: 'Filter folders' }).fill('bet')
    // The server filters (after a short pause in typing): wait for the narrowed list.
    await dialog.getByRole('button', { name: 'Open alpha' }).waitFor({ state: 'detached' })
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
    await dialog.getByText(/missing does not exist\. Showing your home folder\./).waitFor()
    await dialog.getByRole('list', { name: 'Folders' }).waitFor()
    // A notice, not this listing's error: nothing to retry.
    expect(await dialog.getByRole('button', { name: 'Retry' }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    expect(await directory.inputValue()).toBe(join(root, 'missing'))
    // Focus returns to Browse… (the picker's view replaced the form's).
    await page.waitForFunction(() => document.activeElement?.textContent === 'Browse…')
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40000)

browserTest('the folder picker: no choice while a folder loads, a failed folder can be retried, and the filter reaches past the first 500', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bakin-terminal-picker-')))
  mkdirSync(join(root, 'slow'))
  mkdirSync(join(root, 'flaky'))
  for (let n = 0; n < 505; n++) mkdirSync(join(root, 'many', `d${String(n).padStart(4, '0')}`), { recursive: true })
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const held: { release?: () => void } = {}
  const state = { flakyFails: 1, homeFails: 0 }
  try {
    await page.route('**/api/plugins/terminal/options', (route) => route.fulfill({ json: { agents: [], tasks: [], defaults: { cwd: root, agentId: '' } } }))
    await page.route('**/api/plugins/projects/', (route) => route.fulfill({ json: { projects: [] } }))
    await page.route('**/api/plugins/terminal/directories?*', async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')
      if (path === join(root, 'slow')) await new Promise<void>((resolve) => { held.release = resolve })
      if (path === join(root, 'flaky') && state.flakyFails-- > 0) return route.fulfill({ status: 503, json: { error: 'The disk is busy.' } })
      if (!path && state.homeFails-- > 0) return route.fulfill({ status: 503, json: { error: 'The home folder is busy.' } })
      await route.continue()
    })
    await page.goto(process.env.TERMINAL_PREVIEW_URL!)
    await page.getByRole('button', { name: 'New terminal' }).first().click()
    const dialog = page.getByRole('dialog')
    await page.waitForFunction((value) => [...document.querySelectorAll('input')].some((input) => input.value === value), root)
    await dialog.getByRole('button', { name: 'Browse…' }).click()
    const use = dialog.getByRole('button', { name: 'Use this folder' })
    // While "slow" loads, the folder shown is not choosable (it is not the one asked for).
    await dialog.getByRole('button', { name: 'Open slow' }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use this folder')?.disabled === true)
    expect(await dialog.getByText(`Uses ${root}`).count()).toBe(0)
    held.release?.()
    await dialog.getByText(`Uses ${join(root, 'slow')}`).waitFor()
    expect(await use.isEnabled()).toBe(true)
    // A failed folder says why and can be retried (the same place, asked again).
    await dialog.getByRole('button', { name: 'Up to the parent folder' }).click()
    await dialog.getByText(`Uses ${root}`).waitFor()
    await dialog.getByRole('button', { name: 'Open flaky' }).click()
    await dialog.getByText('The disk is busy.').waitFor()
    await dialog.getByRole('button', { name: 'Retry' }).click()
    await dialog.getByText(`Uses ${join(root, 'flaky')}`).waitFor()
    expect(await dialog.getByText('The disk is busy.').count()).toBe(0)
    // A typed path that fails, then home failing too: Retry asks for home again, and its error clears once it loads
    // while the notice about the typed path stays.
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Working directory' }).fill(join(root, 'gone'))
    state.homeFails = 1
    await dialog.getByRole('button', { name: 'Browse…' }).click()
    await dialog.getByText('The home folder is busy.').waitFor()
    await dialog.getByText(/gone does not exist\. Showing your home folder\./).waitFor()
    await dialog.getByRole('button', { name: 'Retry' }).click()
    await dialog.getByRole('list', { name: 'Folders' }).waitFor()
    expect(await dialog.getByText('The home folder is busy.').count()).toBe(0)
    expect(await dialog.getByText(/gone does not exist/).count()).toBe(1)
    await dialog.getByRole('textbox', { name: 'Filter folders' }).waitFor()
    // Back into the tree for the last check.
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Working directory' }).fill(root)
    await dialog.getByRole('button', { name: 'Browse…' }).click()
    await dialog.getByText(`Uses ${root}`).waitFor()
    // Past the first 500: the server filters before its cap.
    await dialog.getByRole('button', { name: 'Open many' }).click()
    await dialog.getByText('Showing the first 500 folders; filter to narrow them.').waitFor()
    // Hundreds of folders: the list scrolls; the filter above it and the choice below stay in view.
    const list = dialog.getByRole('region', { name: 'Folder list' })
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    expect(await dialog.getByRole('button', { name: 'Use this folder' }).isVisible()).toBe(true)
    const dialogBox = (await page.getByRole('dialog').boundingBox())!
    const useBox = (await dialog.getByRole('button', { name: 'Use this folder' }).boundingBox())!
    expect(useBox.y + useBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1)
    await page.screenshot({ path: join(import.meta.dir, '../test-results/live/folder-picker-desktop.png') })
    await dialog.getByRole('textbox', { name: 'Filter folders' }).fill('d0504')
    await dialog.getByRole('button', { name: 'Open d0504' }).waitFor()
    await dialog.getByRole('button', { name: 'Open d0000' }).waitFor({ state: 'detached' })
    expect(await dialog.getByRole('list', { name: 'Folders' }).getByRole('button').count()).toBe(1)
  } finally {
    held.release?.()
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40000)
