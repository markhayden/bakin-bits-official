import { expect } from 'bun:test'
import { browserTest, launchChromium } from './browser'

/** Whichever workspace header is showing (the immersive page swaps in the compact one as it scrolls). */
const header = (page: Awaited<ReturnType<Awaited<ReturnType<typeof launchChromium>>['newPage']>>) => page.locator('[data-slot="workspace-page-compact-header"], [data-slot="workspace-page-header"]').filter({ visible: true })

/** The preview's managed tmux (dev-server prints it); a terminal app is a tmux client on its own PTY. */
const tmux = () => process.env.TERMINAL_PREVIEW_TMUX ?? Bun.which('tmux')!

browserTest('the session shows its attach command, and a terminal app attaching or leaving shows in the header and list', async () => {
  const browser = await launchChromium()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const base = process.env.TERMINAL_PREVIEW_URL!
  const operator = { 'Content-Type': 'application/json', 'X-Bakin-Operator': 'declared', 'X-Bakin-Origin': 'cli' }
  let app: ReturnType<typeof Bun.spawn> | undefined
  let id: string | undefined
  try {
    await page.goto(base)
    await page.getByRole('button', { name: 'New terminal' }).first().click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Handoff')
    await page.getByRole('textbox', { name: 'Working directory' }).fill('/tmp')
    await page.getByRole('combobox', { name: 'Assigned agent' }).click()
    await page.getByRole('option', { name: 'Unassigned', exact: true }).click()
    const creation = page.waitForResponse((response) => response.url().endsWith('/terminal/sessions') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click()
    id = (await (await creation).json()).id as string
    await page.locator('.xterm-helper-textarea').waitFor()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('.terminal-pane')?.getAttribute('data-fit') === 'pane')

    // Details carries the short id and the copyable attach command (full id, operator flag).
    await header(page).getByRole('button', { name: 'Session details' }).first().click()
    const details = page.getByRole('dialog')
    await expect(details.getByText(`ID ${id.replace('terminal-', '').slice(0, 8)}`).isVisible()).resolves.toBe(true)
    await expect(details.getByText(`bakin terminal attach ${id} --as human`).isVisible()).resolves.toBe(true)
    await expect(details.getByRole('button', { name: 'Copy attach command' }).isVisible()).resolves.toBe(true)
    await page.keyboard.press('Escape')
    expect(await page.getByText('Open in a terminal app').count()).toBe(0)

    // The CLI's side of `bakin terminal attach`: reserve, launch tmux, confirm the pid.
    const prepared = await (await Bun.fetch(new URL('/api/plugins/terminal/cli/attach', base), { method: 'POST', headers: operator, body: JSON.stringify({ params: { ref: id }, caller: { cwd: '/tmp' } }) })).json() as { args: string[]; confirm: { path: string; token: string } }
    app = Bun.spawn([tmux(), ...prepared.args], { terminal: { cols: 120, rows: 36, data: () => {} } })
    const confirmed = await Bun.fetch(new URL(`/api/plugins/terminal${prepared.confirm.path}`, base), { method: 'POST', headers: operator, body: JSON.stringify({ token: prepared.confirm.token, pid: app.pid }) })
    expect(confirmed.status).toBe(200)
    await header(page).getByText('Open in a terminal app').first().waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label^="Terminal size"]')?.getAttribute('aria-label')?.includes('120×36, sized by terminal app'))

    // The list shows it too, while the app stays attached.
    await page.goto(base)
    await page.getByRole('row', { name: /Handoff/ }).getByText('Open in a terminal app').waitFor()

    // The app leaves (Ctrl-b d or closing the window): the indicator goes, the size holds frozen.
    await page.goto(new URL(`/terminal/${id}`, base).href)
    await header(page).getByText('Open in a terminal app').first().waitFor()
    app.kill()
    await app.exited
    await header(page).getByText('Open in a terminal app').first().waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('[aria-label^="Terminal size"]')?.getAttribute('aria-label')?.includes('size frozen'))
    expect(errors).toEqual([])
  } finally {
    app?.kill()
    if (id) {
      const headers = { 'Content-Type': 'application/json', 'X-Bakin-Terminal-Client': 'handoff-browser-test-01', Origin: new URL(base).origin }
      await Bun.fetch(new URL('/api/plugins/terminal/session', base), { method: 'POST', headers, body: JSON.stringify({ id, operation: 'terminate' }) }).catch(() => undefined)
    }
    await browser.close()
  }
}, 60000)
