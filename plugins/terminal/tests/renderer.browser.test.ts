import { expect } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserTest, launchChromium } from './browser'

for (const renderer of ['webgl', 'blocked', 'lost', 'scaled', 'rescaled'] as const) {
  // Changing DPR on an already-open page requires Chromium's DevTools API.
  if (renderer === 'rescaled' && process.env.TERMINAL_BROWSER === 'webkit') continue
  browserTest(`terminal paints and accepts input with renderer ${renderer}`, async () => {
    const browser = await launchChromium()
    // Keep the GPU cases at the host scale; the scaled case deliberately
    // exercises Chromium's conflicting emulated pixel measurements.
    const page = await browser.newPage(renderer === 'scaled' || renderer === 'rescaled'
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: renderer === 'scaled' ? 3 : 1, hasTouch: true, isMobile: true }
      : { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 })
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    if (renderer === 'blocked') await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (kind === 'webgl' || kind === 'webgl2') return null
        return Reflect.apply(getContext, this, [kind, ...args])
      } as typeof getContext
    })
    const endpoint = new URL('/api/plugins/terminal/session', process.env.TERMINAL_PREVIEW_URL!).href
    const headers = { 'X-Bakin-Terminal-Client': 'renderer-browser-test' }
    let id: string | undefined
    try {
      const created = await page.request.post(endpoint + 's', { headers, data: { title: 'Renderer proof', cwd: '/tmp' } })
      expect(created.ok()).toBe(true)
      id = (await created.json()).id
      await page.goto(new URL('/terminal/' + id, endpoint).href)
      const input = page.locator('.xterm-helper-textarea')
      await input.waitFor()
      await page.locator('[data-archetype="workspace"]').evaluate(el => { el.scrollTop = el.scrollHeight })
      if (renderer === 'webgl' || renderer === 'lost' || renderer === 'rescaled') await page.locator('.xterm-screen canvas:not(.xterm-link-layer)').waitFor()
      if (renderer === 'rescaled') {
        // Preserve CSS dimensions: a content-box resize observer alone will
        // miss this change and leave WebGL painting a clipped, blank canvas.
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
        await page.waitForFunction(() => !document.querySelector('.xterm-screen canvas:not(.xterm-link-layer)'))
        await cdp.detach()
      }
      if (renderer === 'lost') {
        expect(await page.locator('.xterm-screen canvas:not(.xterm-link-layer)').evaluate(canvas => {
          const gl = (canvas as HTMLCanvasElement).getContext('webgl2')
          const extension = gl?.getExtension('WEBGL_lose_context')
          extension?.loseContext()
          return Boolean(extension)
        })).toBe(true)
        await page.waitForFunction(() => !document.querySelector('.xterm-screen canvas:not(.xterm-link-layer)'))
      }
      await input.focus()
      const start = performance.now()
      await page.keyboard.type("printf '\\033[32mRENDER_%s \\342\\234\\223\\033[0m\\n' OK")
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('RENDER_OK'))
      const outputMs = Math.round(performance.now() - start)
      // The accessibility tree can contain text while WebGL paints a blank
      // canvas. Check actual pixels, including Chromium's emulated DPR case.
      const screenshot = await page.locator('.xterm-screen').screenshot()
      const foreground = await page.evaluate(async encoded => {
        const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let visible = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 100 && pixels[i + 3] > 0) visible++
        }
        return visible
      }, screenshot.toString('base64'))
      expect(foreground).toBeGreaterThan(300)
      // A bounded, colored Unicode burst exercises real rendering and the stream queue.
      await page.keyboard.type("i=0; while [ $i -lt 200 ]; do printf '\\033[36mrow %s \\342\\234\\223\\033[0m\\n' $i; i=$((i+1)); done; printf 'BURST_%s\\n' DONE")
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('BURST_DONE'))
      await page.setViewportSize({ width: 800, height: 600 })
      const folder = join(import.meta.dir, '../test-results/rendering')
      mkdirSync(folder, { recursive: true })
      await page.screenshot({ path: join(folder, renderer + '.png') })
      for (let i = 0; i < 3; i++) {
        await page.goto(new URL('/terminal', endpoint).href)
        await page.goto(new URL('/terminal/' + id, endpoint).href)
        await page.waitForFunction(() => document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('BURST_DONE'))
      }
      console.log(JSON.stringify({ renderer, firstOutputMs: outputMs }))
      expect(errors).toEqual([])
    } finally {
      try {
        if (id) {
          const taken = await page.request.post(endpoint, { headers, data: { id, operation: 'take' } })
          expect(taken.ok()).toBe(true)
          const session = await taken.json()
          const ended = await page.request.post(endpoint, { headers, data: { id, operation: 'terminate', generation: session.generation } })
          expect(ended.ok()).toBe(true)
        }
      } finally { await page.close(); await browser.close() }
    }
  }, 60000)
}
