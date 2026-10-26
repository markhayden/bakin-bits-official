/**
 * Deterministic UI fixtures have no terminal server: answer the viewer
 * socket's hello with one sync (snapshot + session), accept everything else.
 */
export function installFixtureSocket(sync: { session: Record<string, unknown>; snapshot: string }): void {
  class FixtureSocket {
    binaryType = 'arraybuffer'
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    constructor(readonly url: string) { queueMicrotask(() => { this.readyState = 1; this.onopen?.() }) }
    send(data: string): void {
      if ((JSON.parse(data) as { type: string }).type !== 'hello') return
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'sync', epoch: 1, cursor: 0, session: sync.session, snapshot: btoa(sync.snapshot) }) }))
    }
    close(code = 1000): void { this.readyState = 3; this.onclose?.({ code }) }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FixtureSocket })
}
