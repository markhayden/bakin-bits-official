/**
 * Deterministic UI fixtures have no terminal server: answer the viewer
 * socket's hello with one picture, accept everything else: a join
 * carrying the session's fidelity, its text and the barrier, so the page
 * shows what that fidelity discloses (plan T35a).
 */
/** A join for `session` showing `text`: its header, the text, and the barrier (what the server sends a viewer that says hello). */
export function joinFrames(session: Record<string, unknown>, text: string, fidelity: Record<string, unknown> = { rebuilds: {} }): Array<string | ArrayBuffer> {
  const bytes = new TextEncoder().encode(text)
  const { cols, rows } = session as { cols: number; rows: number }
  return [
    JSON.stringify({ type: 'join', epoch: 1, session, sizeFrozen: false, nativeClients: 0, fidelity, history: 'complete',
      checkpoint: { format: 1, cols, rows, scrollback: 10_000, joinState: 0, penHasExtended: false, altEnteredCols: null, altEntry: null }, bytes: bytes.length, baseSeq: 1, throughSeq: 1 }),
    bytes.buffer,
    JSON.stringify({ type: 'barrier', epoch: 1, throughSeq: 1 }),
  ]
}

export function installFixtureSocket(picture: { session: Record<string, unknown>; snapshot: string; fidelity: Record<string, unknown> }): void {
  class FixtureSocket {
    binaryType = 'arraybuffer'
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    constructor(readonly url: string) { queueMicrotask(() => { this.readyState = 1; this.onopen?.() }) }
    send(data: unknown): void {
      if (typeof data !== 'string' || (JSON.parse(data) as { type: string }).type !== 'hello') return
      const frames = joinFrames(picture.session, picture.snapshot, picture.fidelity)
      queueMicrotask(() => { for (const frame of frames) this.onmessage?.({ data: frame }) })
    }
    close(code = 1000): void { this.readyState = 3; this.onclose?.({ code }) }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FixtureSocket })
}
