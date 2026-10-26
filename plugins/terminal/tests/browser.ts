import { test } from 'bun:test'

// Importing playwright at module top crashes bun 1.3.13's --isolate runner
// (intermittent SIGSEGV across the whole suite) even when every test in the
// file is skipped, so the module loads only when a live preview makes the
// browser tests runnable.
export const browserTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip

export async function launchChromium() {
  const { chromium, webkit } = await import('playwright')
  const engine = process.env.TERMINAL_BROWSER === 'webkit' ? webkit : chromium
  return engine.launch({ headless: true })
}

type SocketFrame = { type: string } & Record<string, unknown>
type PageLike = {
  on(event: 'websocket', listener: (socket: { url(): string; on(event: 'framesent', listener: (frame: { payload: string | Buffer }) => void): void }) => void): void
  routeWebSocket(url: string, handler: (socket: { connectToServer(): unknown }) => void): Promise<void>
}

/**
 * The JSON frames this page sends on the terminal viewer socket, and a switch
 * that holds new sockets off the server (they open but never sync), the way
 * a dropped network looks to the client.
 */
export async function viewerSocket(page: PageLike) {
  const sent: SocketFrame[] = []
  const state = { blocked: false }
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/plugins/terminal/socket')) return
    socket.on('framesent', (frame) => { if (typeof frame.payload === 'string') sent.push(JSON.parse(frame.payload)) })
  })
  await page.routeWebSocket('**/api/plugins/terminal/socket**', (socket) => { if (!state.blocked) socket.connectToServer() })
  const of = (type: string) => sent.filter((frame) => frame.type === type)
  return {
    sent,
    /** Concatenated input text in send order (keystrokes may coalesce). */
    typed: () => of('input').map((frame) => String(frame.data)).join(''),
    inputs: () => of('input'),
    resizes: () => of('resize'),
    block: (blocked: boolean) => { state.blocked = blocked },
    /** Input leaves after coalescing (≤ 8 ms, or behind an envelope in flight): wait for it. */
    async waitForTyped(text: string, timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (!of('input').map((frame) => String(frame.data)).join('').includes(text)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for typed ${JSON.stringify(text)}; typed: ${JSON.stringify(of('input').map((frame) => frame.data).join(''))}`)
        await Bun.sleep(25)
      }
    },
    async waitFor(predicate: (frame: SocketFrame) => boolean, timeoutMs = 10_000): Promise<SocketFrame> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = sent.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`timed out waiting for a viewer socket frame; sent: ${JSON.stringify(sent.filter((frame) => frame.type !== 'ack' && frame.type !== 'pong').slice(-8))}`)
        await Bun.sleep(25)
      }
    },
  }
}
