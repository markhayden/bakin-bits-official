/**
 * Deterministic UI fixtures have no terminal server: answer the viewer
 * socket's hello with one picture, accept everything else. The bridge
 * path's is a sync (snapshot + session); the raw path's (`fidelity` given)
 * a join carrying the session's fidelity, its text and the barrier, so the
 * page shows what that fidelity discloses (plan T35a).
 */
export function installFixtureSocket(picture: { session: Record<string, unknown>; snapshot: string; fidelity?: Record<string, unknown> }): void {
  class FixtureSocket {
    binaryType = 'arraybuffer'
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    constructor(readonly url: string) { queueMicrotask(() => { this.readyState = 1; this.onopen?.() }) }
    send(data: unknown): void {
      if (typeof data !== 'string' || (JSON.parse(data) as { type: string }).type !== 'hello') return
      if (!picture.fidelity) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'sync', epoch: 1, cursor: 0, session: picture.session, snapshot: btoa(picture.snapshot) }) }))
        return
      }
      const text = new TextEncoder().encode(picture.snapshot)
      const { cols, rows } = picture.session as { cols: number; rows: number }
      const frames: unknown[] = [
        JSON.stringify({ type: 'join', epoch: 1, session: picture.session, sizeFrozen: false, nativeClients: 0, fidelity: picture.fidelity, history: 'complete',
          checkpoint: { format: 1, cols, rows, scrollback: 10_000, joinState: 0, penHasExtended: false, altEnteredCols: null, altEntry: null }, bytes: text.length, baseSeq: 1, throughSeq: 1 }),
        text.buffer,
        JSON.stringify({ type: 'barrier', epoch: 1, throughSeq: 1 }),
      ]
      queueMicrotask(() => { for (const frame of frames) this.onmessage?.({ data: frame }) })
    }
    close(code = 1000): void { this.readyState = 3; this.onclose?.({ code }) }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FixtureSocket })
}
