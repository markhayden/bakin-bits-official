import { expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { TerminalService } from '../lib/service'
import { launchChromium } from './browser'

// Spec item 8 / plan T23b against the preview: images reach the compose
// draft by the picker, a paste or a drop, are uploaded (the preview serves
// the plugin's upload route), and go to the program through Paste — a shell
// gets the path shell-quoted. TERMINAL_PREVIEW_TMUX and TERMINAL_PREVIEW_ROOT
// are the tmux and workingDirectory the preview printed.
const previewTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip
const base = () => process.env.TERMINAL_PREVIEW_URL!
const endpoint = (path: string) => new URL(`/api/plugins/terminal${path}`, base()).href

/** A real 4×4 PNG (signature, IHDR, IDAT, IEND, with CRCs). */
function png(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = ~0
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)) }
    return ~value >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array.from({ length: 12 }, () => 200)])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

previewTest('desktop: a dropped image opens compose, a pasted one joins it, the picker adds one; Paste sends their quoted paths to a shell', async () => {
  const browser = await launchChromium()
  const client = 'images-browser-test-0001'
  const headers = { 'X-Bakin-Terminal-Client': client }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const { id } = await (await page.request.post(endpoint('/sessions'), { headers, data: { title: 'Images', cwd: '/tmp' } })).json() as { id: string }
    await page.goto(new URL(`/terminal/${id}`, base()).href)
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    const bytes = [...png()]
    // Drop on the terminal: compose opens with the image uploading, then kept.
    await page.locator('.terminal-pane').evaluate((pane, data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' }))
      pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, bytes)
    const compose = page.getByRole('region', { name: 'Compose' })
    await compose.waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Copy the path of dropped.png' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))).toBe('Text to send')
    // Pasted into the text: a second image.
    await page.getByRole('textbox', { name: 'Text to send' }).evaluate((textarea, data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'pasted.png', { type: 'image/png' }))
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    }, bytes)
    await page.getByRole('button', { name: 'Copy the path of pasted.png' }).waitFor({ timeout: 10_000 })
    // The picker: a third.
    await compose.locator('input[type="file"]').setInputFiles({ name: 'picked.png', mimeType: 'image/png', buffer: png() })
    await page.getByRole('button', { name: 'Copy the path of picked.png' }).waitFor({ timeout: 10_000 })
    await page.getByRole('textbox', { name: 'Text to send' }).fill('printf "%s\\n"')
    await page.getByRole('button', { name: 'Paste + Enter', exact: true }).click()
    // The shell ran printf with the three quoted paths: each printed on its own line, under the session's upload folder.
    const tmux = process.env.TERMINAL_PREVIEW_TMUX!
    const socket = new TerminalService(process.env.TERMINAL_PREVIEW_ROOT!).socket
    const screen = () => Bun.spawnSync([tmux, '-S', socket, 'capture-pane', '-p', '-J', '-t', id]).stdout.toString()
    for (let tries = 0; tries < 50 && (screen().match(new RegExp(`/uploads/${id}/[0-9a-f-]{36}\\.png$`, 'gm')) ?? []).length < 3; tries++) await Bun.sleep(100)
    expect((screen().match(new RegExp(`^${process.env.TERMINAL_PREVIEW_ROOT}/uploads/${id}/[0-9a-f-]{36}\\.png$`, 'gm')) ?? []).length).toBe(3)
    // Sent: the draft is empty and compose closed.
    await compose.waitFor({ state: 'detached', timeout: 5000 })
    const taken = await (await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'take' } })).json() as { generation: number }
    await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'terminate', generation: taken.generation } })
  } finally {
    await browser.close()
  }
}, 90_000)

previewTest('an image whose upload is overtaken by a change of driver is refused, and shown so', async () => {
  const browser = await launchChromium()
  const client = 'images-browser-test-0002'
  const headers = { 'X-Bakin-Terminal-Client': client }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const { id } = await (await page.request.post(endpoint('/sessions'), { headers, data: { title: 'Race', cwd: '/tmp' } })).json() as { id: string }
    await page.goto(new URL(`/terminal/${id}`, base()).href)
    await page.waitForFunction(() => document.querySelector('[data-display]')?.getAttribute('data-display') === 'live', null, { timeout: 15_000 })
    // The upload is held until the session changes hands (another screen takes it over: a new generation).
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/plugins/terminal/upload**', async (route) => { await held; await route.continue() })
    await page.locator('[data-slot="workspace-page-compact-header"], [data-slot="workspace-page-header"]').filter({ visible: true }).getByRole('button', { name: 'Session actions' }).first().click()
    await page.getByRole('menuitem', { name: 'Compose…' }).click()
    await page.getByRole('region', { name: 'Compose' }).locator('input[type="file"]').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: png() })
    await page.getByRole('status', { name: 'Uploading late.png' }).waitFor({ timeout: 5000 })
    await page.request.post(endpoint('/session'), { headers: { 'X-Bakin-Terminal-Client': 'images-browser-other-01' }, data: { id, operation: 'take' } })
    release()
    await page.getByRole('alert').filter({ hasText: 'late.png' }).waitFor({ timeout: 10_000 })
    expect(await page.getByRole('alert').filter({ hasText: 'late.png' }).textContent()).toContain('Input ownership changed')
    const taken = await (await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'take' } })).json() as { generation: number }
    await page.request.post(endpoint('/session'), { headers, data: { id, operation: 'terminate', generation: taken.generation } })
  } finally {
    await browser.close()
  }
}, 60_000)
