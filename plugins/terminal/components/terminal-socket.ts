/**
 * Browser side of the terminal viewer socket (lib/socket.ts has the
 * protocol). Owns: hello → sync, ACK-after-write batching, input
 * coalescing with per-connection sequences, results, heartbeats and
 * reconnect. Input is never replayed: whatever was in flight when a socket
 * dropped is the caller's "may have been delivered".
 */
import type { Session } from '../lib/contracts'

export interface SocketLike {
  binaryType: string
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string): void
  close(code?: number): void
}

export interface SyncMessage { epoch: number; session: Session; snapshot: string; cursor: number }
export interface InputResult { viewerSeq: number; status: 'accepted' | 'rejected' | 'uncertain'; error?: string }

/** Server close codes (lib/socket.ts SOCKET_CLOSE) that must not auto-reconnect. */
const TERMINAL_CLOSES: Record<number, string> = { 4001: 'Opened in another tab', 4004: 'Session not found' }

export interface TerminalSocketOptions {
  url: string
  clientId: string
  onSync(sync: SyncMessage): void
  /** Write the bytes to xterm and call `done` from its write callback. */
  onOutput(bytes: Uint8Array, done: () => void): void
  onSession(session: Session): void
  onResult(result: InputResult): void
  onStatus(status: string): void
  createSocket?: (url: string) => SocketLike
  ackBytes?: number
  ackMs?: number
  coalesceMs?: number
  coalesceBytes?: number
  reconnectMs?: number[]
}

export class TerminalSocketClient {
  private socket: SocketLike | undefined
  private synced = false
  private stopped = false
  private viewerSeq = 0
  /** Sent envelopes awaiting their result: viewerSeq → generation. */
  private inFlight = new Map<number, number>()
  private pending: { generation: number; data: string } | undefined
  private epoch = -1
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private written = 0
  private ackedSent = 0
  private ackTimer: ReturnType<typeof setTimeout> | undefined
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private options: TerminalSocketOptions) {}

  connect(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.stopped || (this.socket && this.socket.readyState <= 1)) return
    this.reset()
    this.options.onStatus(this.retry ? 'Reconnecting' : 'Connecting')
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(this.options.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => { socket.send(JSON.stringify({ type: 'hello', clientId: this.options.clientId })) }
    socket.onmessage = (event) => { if (this.socket === socket) this.receive(event.data) }
    socket.onclose = (event) => { if (this.socket === socket) this.dropped(event.code) }
  }

  /** A reconnect is already scheduled: run it now instead of waiting. */
  resume(): void {
    if (this.stopped || this.retryTimer === undefined) return
    this.connect()
  }

  /**
   * Replace the connection now, even one that looks open (a phone back from
   * the background may hold a dead socket): fresh hello, fresh sync.
   */
  reconnect(): void {
    if (this.stopped) return
    const old = this.socket
    this.socket = undefined
    this.lost()
    old?.close(4000)
    this.connect()
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.reset()
    this.socket?.close(1000)
    this.socket = undefined
  }

  /** Queue input for `generation`; false when it cannot be sent (not synced). */
  input(generation: number, data: string): boolean {
    if (!this.synced || !data) return false
    if (this.pending && this.pending.generation !== generation) this.flush()
    if (this.inFlight.size === 0 && !this.pending) {
      this.envelope(generation, data)
      return true
    }
    this.pending = this.pending ? { generation, data: this.pending.data + data } : { generation, data }
    if (this.pending.data.length >= (this.options.coalesceBytes ?? 4096)) this.flush()
    else this.flushTimer ??= setTimeout(() => this.flush(), this.options.coalesceMs ?? 8)
    return true
  }

  /** True when the resize was sent (a disconnected client sends nothing). */
  resize(generation: number, cols: number, rows: number): boolean {
    if (!this.synced || !this.socket) return false
    this.socket.send(JSON.stringify({ type: 'resize', generation, cols, rows }))
    return true
  }

  private envelope(generation: number, data: string): void {
    const viewerSeq = ++this.viewerSeq
    this.inFlight.set(viewerSeq, generation)
    this.socket?.send(JSON.stringify({ type: 'input', generation, viewerSeq, data }))
  }

  private flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const pending = this.pending
    this.pending = undefined
    if (pending && this.synced) this.envelope(pending.generation, pending.data)
  }

  private receive(raw: unknown): void {
    if (raw instanceof ArrayBuffer) {
      const bytes = new Uint8Array(raw)
      const epoch = this.epoch
      // A write finishing after a resync belongs to a discarded picture.
      this.options.onOutput(bytes, () => { if (epoch === this.epoch) this.written_(bytes.byteLength) })
      return
    }
    const message = JSON.parse(String(raw)) as { type: string } & Record<string, unknown>
    switch (message.type) {
      case 'sync':
        this.synced = true
        this.retry = 0
        this.epoch = Number(message.epoch)
        this.written = 0
        this.ackedSent = 0
        clearTimeout(this.ackTimer)
        this.ackTimer = undefined
        this.options.onSync(message as unknown as SyncMessage)
        this.options.onStatus((message.session as Session).state === 'completed' ? 'Completed' : 'Connected')
        return
      case 'session': this.options.onSession(message.session as Session); return
      case 'result': {
        const result = message as unknown as InputResult
        const generation = this.inFlight.get(result.viewerSeq)
        this.inFlight.delete(result.viewerSeq)
        if (result.status === 'rejected' && this.pending && this.pending.generation === generation) {
          // A refused envelope means the state it was typed against is gone;
          // input queued for that same state goes with it.
          clearTimeout(this.flushTimer)
          this.flushTimer = undefined
          this.pending = undefined
        }
        this.options.onResult({ viewerSeq: result.viewerSeq, status: result.status, ...(result.error ? { error: result.error } : {}) })
        if (this.inFlight.size === 0 && this.pending) this.flush()
        return
      }
      case 'ping': this.socket?.send(JSON.stringify({ type: 'pong' })); return
      case 'error': this.options.onStatus(String(message.error)); return
    }
  }

  private written_(bytes: number): void {
    this.written += bytes
    if (this.written - this.ackedSent >= (this.options.ackBytes ?? 16 * 1024)) this.ack()
    else this.ackTimer ??= setTimeout(() => this.ack(), this.options.ackMs ?? 50)
  }

  private ack(): void {
    clearTimeout(this.ackTimer)
    this.ackTimer = undefined
    if (this.written === this.ackedSent) return
    this.ackedSent = this.written
    this.socket?.send(JSON.stringify({ type: 'ack', epoch: this.epoch, bytes: this.written }))
  }

  private reset(): void {
    this.synced = false
    this.viewerSeq = 0
    this.inFlight.clear()
    this.pending = undefined
    this.epoch = -1
    clearTimeout(this.flushTimer)
    clearTimeout(this.ackTimer)
    this.flushTimer = undefined
    this.ackTimer = undefined
  }

  /** Tell the caller about input a lost connection leaves unresolved — never resend it. */
  private lost(): void {
    // ONE outcome per drop, and uncertainty wins: a later "not sent" must
    // never hide input that may already have run.
    const lastSent = [...this.inFlight.keys()].at(-1)
    if (lastSent !== undefined) {
      this.options.onResult({ viewerSeq: lastSent, status: 'uncertain', error: this.pending
        ? 'The connection dropped before your input was confirmed; anything typed after it was not sent'
        : 'The connection dropped before this input was confirmed' })
    } else if (this.pending) {
      this.options.onResult({ viewerSeq: 0, status: 'rejected', error: 'The connection dropped before this input was sent' })
    }
    this.reset()
  }

  private dropped(code: number): void {
    this.lost()
    this.socket = undefined
    if (this.stopped) return
    const terminal = TERMINAL_CLOSES[code]
    if (terminal) { this.options.onStatus(terminal); return }
    const delays = this.options.reconnectMs ?? [500, 1000, 2000, 5000, 10000]
    this.options.onStatus('Reconnecting')
    this.retryTimer = setTimeout(() => this.connect(), delays[Math.min(this.retry, delays.length - 1)])
    this.retry++
  }
}
