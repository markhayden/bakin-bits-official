import { expect } from 'bun:test'
import { browserTest, launchChromium } from './browser'

// Spec D9 item 4: a plain-text URL in the output is a link (the web-links
// addon), opened like xterm's own handler: confirmed, in a new window with no
// opener. Against a disposable preview (TERMINAL_PREVIEW_URL).
browserTest('a URL printed by the program opens, confirmed, in a new window without an opener', async () => {
  const browser = await launchChromium()
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } })
  // The link's page is stubbed: nothing leaves the machine.
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }))
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  const headers = { 'X-Bakin-Terminal-Client': 'links-browser-test-run' }
  let id: string | undefined
  try {
    const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Links', cwd: '/tmp' } })
    const session = await created.json() as { id: string; cols: number; rows: number }
    id = session.id
    await page.goto(new URL('/terminal/' + id, endpoint).href)
    const input = page.locator('.xterm-helper-textarea')
    await input.waitFor({ state: 'attached' })
    await input.focus()
    await page.keyboard.type("clear; printf 'see https://example.com/bakin-link-test for more\\n'")
    await page.keyboard.press('Enter')
    const rows = page.locator('.xterm-accessibility-tree > div')
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-accessibility-tree > div')].some(row => row.textContent?.startsWith('see https://')))
    // The cell over the URL: its row (the accessibility rows mirror the screen) and column.
    const row = await rows.evaluateAll(all => all.findIndex(element => element.textContent?.startsWith('see https://')))
    const screen = await page.locator('.xterm-screen').boundingBox()
    // The grid is the session's size (nobody sized it, so the screen renders it as created).
    const cell = { width: screen!.width / session.cols, height: screen!.height / session.rows }
    const at = { x: screen!.x + cell.width * 10.5, y: screen!.y + cell.height * (row + 0.5) }
    let confirmed = ''
    page.once('dialog', async (dialog) => { confirmed = dialog.message(); await dialog.accept() })
    await page.mouse.move(at.x, at.y)
    await page.mouse.move(at.x + 1, at.y)
    const popup = context.waitForEvent('page')
    await page.mouse.click(at.x + 1, at.y)
    const opened = await popup
    await opened.waitForURL('https://example.com/bakin-link-test')
    expect(confirmed).toContain('https://example.com/bakin-link-test')
    expect(await opened.evaluate(() => window.opener)).toBeNull()
    // Declining opens nothing.
    page.once('dialog', (dialog) => { void dialog.dismiss() })
    const pages = context.pages().length
    await page.mouse.click(at.x + 1, at.y)
    await page.waitForTimeout(300)
    expect(context.pages().length).toBe(pages)
  } finally {
    try {
      if (id) {
        const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
        const owned = await taken.json()
        await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: owned.generation } })
      }
    } finally { await browser.close() }
  }
}, 60000)
