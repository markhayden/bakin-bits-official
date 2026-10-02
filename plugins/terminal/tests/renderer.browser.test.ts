import { expect } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserTest, launchChromium } from './browser'

for (const renderer of ['webgl', 'blocked', 'lost'] as const) {
  browserTest(`terminal paints and accepts input with renderer ${renderer}`, async () => {
    const browser = await launchChromium()
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2 })
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
      if (renderer !== 'blocked') await page.locator('.xterm-screen canvas:not(.xterm-link-layer)').waitFor()
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
      } finally { await browser.close() }
    }
  }, 60000)
}
