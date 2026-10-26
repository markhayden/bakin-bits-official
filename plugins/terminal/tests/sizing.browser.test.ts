import { expect } from 'bun:test'
import { browserTest, launchChromium, viewerSocket } from './browser'

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchChromium>>['newPage']>>

const sizeButton = (page: Page) => page.locator('[data-slot="workspace-page-compact-header"], [data-slot="workspace-page-header"]').filter({ visible: true }).getByRole('button', { name: /^Terminal size / }).first()
const font = (page: Page) => page.evaluate(() => Number(document.querySelector('.terminal-pane')!.getAttribute('data-font-size')))
const pane = (page: Page) => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('.terminal-pane')!
  return { fit: el.dataset.fit, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, maxLeft: el.scrollWidth - el.clientWidth, maxTop: el.scrollHeight - el.clientHeight, overflowX: el.scrollWidth > el.clientWidth, overflowY: el.scrollHeight > el.clientHeight }
})

browserTest('one screen sizes the session; another renders the real grid, pans, pinches and follows the cursor', async () => {
  const browser = await launchChromium()
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
  const phone = await phoneContext.newPage()
  for (const page of [desk, phone]) page.setDefaultTimeout(10000)
  const errors: string[] = []
  desk.on('pageerror', (error) => errors.push(error.message))
  phone.on('pageerror', (error) => errors.push(error.message))
  const deskSocket = await viewerSocket(desk)
  const phoneSocket = await viewerSocket(phone)
  const headers = { 'X-Bakin-Terminal-Client': 'sizing-browser-test-0001' }
  const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
  let id: string | undefined
  try {
    // The desktop creates the session, so it sizes it.
    await desk.goto(process.env.TERMINAL_PREVIEW_URL!)
    await desk.getByRole('button', { name: 'New terminal' }).first().click()
    await desk.getByRole('textbox', { name: 'Name', exact: true }).fill('Sizing')
    await desk.getByRole('textbox', { name: 'Working directory' }).fill('/tmp')
    await desk.getByRole('combobox', { name: 'Assigned agent' }).click()
    await desk.getByRole('option', { name: 'Unassigned', exact: true }).click()
    const creation = desk.waitForResponse((response) => response.url().endsWith('/terminal/sessions') && response.request().method() === 'POST')
    await desk.getByRole('button', { name: 'Start terminal', exact: true }).click()
    const created = await (await creation).json()
    id = created.id
    expect(created.sizeAuthority).toMatchObject({ kind: 'browser', device: 'desktop' })
    await desk.locator('.xterm-helper-textarea').waitFor()
    await deskSocket.waitFor((frame) => frame.type === 'resize')
    await desk.waitForFunction(() => document.querySelector('.terminal-pane')?.getAttribute('data-fit') === 'pane')
    expect(await sizeButton(desk).getAttribute('aria-label')).toContain('sized by this device')
    // Enough lines that the phone has something to pan over vertically too.
    await desk.locator('.xterm-helper-textarea').focus()
    await desk.keyboard.type('for i in $(seq 1 80); do echo "line $i"; done; printf "%0.sW" $(seq 1 160); echo')
    await desk.keyboard.press('Enter')
    await desk.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('line 80'))
    const deskGrid = await desk.evaluate(() => document.querySelector('[aria-label^="Terminal size"]')!.getAttribute('aria-label'))

    // The phone only views: it never resizes, and renders the desktop's grid at a fitted font.
    await phone.goto(new URL('/terminal/' + id, endpoint).href)
    await phone.locator('.xterm-helper-textarea').waitFor()
    await phone.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('line 80'))
    await phone.waitForTimeout(400)
    expect(phoneSocket.resizes()).toEqual([])
    expect(phoneSocket.sent.filter((frame) => frame.type === 'claim')).toEqual([])
    expect(await sizeButton(phone).getAttribute('aria-label')).toContain('sized by desktop')
    const fitted = await pane(phone)
    expect(fitted.fit).toBe('width')
    expect(await font(phone)).toBe(10)
    expect(fitted.overflowX).toBe(true)
    expect(await desk.evaluate(() => document.querySelector('[aria-label^="Terminal size"]')!.getAttribute('aria-label'))).toBe(deskGrid)

    // A one-finger pan scrolls natively, pauses follow, and never opens the keyboard or types.
    const cdp = await phoneContext.newCDPSession(phone)
    const box = (await phone.locator('.terminal-pane').boundingBox())!
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const typedBefore = phoneSocket.inputs().length
    const start = await pane(phone)
    // The view starts on the cursor (bottom-left after the output): pan up and right, away from it.
    expect(start.scrollLeft).toBe(0)
    expect(start.scrollTop).toBeGreaterThan(start.maxTop - 24)
    await cdp.send('Input.synthesizeScrollGesture', { x: centre.x, y: centre.y, xDistance: -200, yDistance: 200, gestureSourceType: 'touch', speed: 800 })
    await phone.getByRole('button', { name: 'Follow cursor', exact: true }).waitFor()
    expect(await phone.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(false)
    expect(phoneSocket.inputs().length).toBe(typedBefore)
    const panned = await pane(phone)
    expect(panned.scrollLeft).toBeGreaterThan(100)
    expect(panned.scrollTop).toBeLessThan(start.maxTop - 100)

    // Follow cursor brings the cursor back into view.
    await phone.getByRole('button', { name: 'Follow cursor', exact: true }).tap()
    await phone.getByRole('button', { name: 'Follow cursor', exact: true }).waitFor({ state: 'detached' })
    const followed = await pane(phone)
    // The least scroll that shows the prompt's cursor: back left and down to the last line.
    expect(followed.scrollLeft).toBeLessThan(panned.scrollLeft)
    expect(followed.scrollTop).toBe(start.scrollTop)

    // Pinch sets this device's font, remembered across reloads; Reset view returns to the fit.
    await cdp.send('Input.synthesizePinchGesture', { x: centre.x, y: centre.y, scaleFactor: 2, gestureSourceType: 'touch', relativeSpeed: 400 })
    await phone.getByRole('button', { name: 'Reset view', exact: true }).waitFor()
    const pinched = await font(phone)
    expect(pinched).toBeGreaterThan(14)
    await phone.reload()
    await phone.locator('.xterm-helper-textarea').waitFor()
    await phone.waitForFunction((size) => Number(document.querySelector('.terminal-pane')?.getAttribute('data-font-size')) === size, pinched)
    await phone.getByRole('button', { name: 'Reset view', exact: true }).tap()
    await phone.waitForFunction(() => Number(document.querySelector('.terminal-pane')?.getAttribute('data-font-size')) === 10)
    expect(phoneSocket.resizes()).toEqual([])

    // "Fit to this device" hands the size to the phone; the desktop now renders the phone's grid.
    await sizeButton(phone).tap()
    await phone.getByRole('button', { name: 'Fit to this device', exact: true }).tap()
    const claim = await phoneSocket.waitFor((frame) => frame.type === 'claim')
    expect(claim.device).toBe('phone')
    await desk.waitForFunction(() => document.querySelector('[aria-label^="Terminal size"]')?.getAttribute('aria-label')?.includes('sized by phone'))
    await desk.waitForFunction(() => document.querySelector('.terminal-pane')?.getAttribute('data-fit') === 'width')
    expect(await font(desk)).toBeGreaterThan(13)
    await phone.waitForFunction(() => document.querySelector('.terminal-pane')?.getAttribute('data-fit') === 'pane')

    // The phone leaving freezes the size; the desktop says so and can take it back.
    await phone.close()
    await desk.waitForFunction(() => document.querySelector('[aria-label^="Terminal size"]')?.getAttribute('aria-label')?.includes('size frozen'))
    await sizeButton(desk).click()
    await desk.getByRole('button', { name: 'Fit to this device', exact: true }).click()
    await desk.waitForFunction(() => document.querySelector('[aria-label^="Terminal size"]')?.getAttribute('aria-label')?.includes('sized by this device'))
    expect(errors).toEqual([])
  } finally {
    if (id) await desk.request.post(endpoint, { headers, data: { id, operation: 'terminate' } }).catch(() => undefined)
    await browser.close()
  }
}, 60_000)
