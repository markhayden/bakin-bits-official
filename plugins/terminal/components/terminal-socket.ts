/**
 * Browser side of the terminal viewer socket (lib/socket.ts has the
 * protocol). Owns: hello → sync, ACK-after-write batching, input
 * coalescing with per-connection sequences, results, heartbeats and
 * reconnect. Input is never replayed: whatever was in flight when a socket
 * dropped is the caller's "may have been delivered".
 */
import type { Session } from '../lib/contracts'
import type { Fidelity } from '../lib/raw-display'
import type { UnavailableReason } from '../lib/socket'
import { RawPicture, type DisplayState, type PictureHeader, type PictureTarget } from './raw-picture'
import type { ScreenDevice } from './terminal-view'

export interface SocketLike {
  binaryType: string
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  send(data: string): void
  close(code?: number): void
}

/** Who is around a session besides this screen: whether its size is frozen (the sizing screen or app is away) and how many terminal apps are attached. */
export interface Presence { sizeFrozen: boolean; nativeClients: number }
export interface SyncMessage extends Presence { epoch: number; session: Session; snapshot: string; cursor: number }
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
  /** The screen that sizes the session disconnected (true) or is back (false); every sync says it too. */
  onPresence(presence: Presence): void
  onResult(result: InputResult): void
  /** Connection status: `Connected` once input may flow (bridge: the sync; raw path: the first applied replay). */
  onStatus(status: string): void
  /** The raw path: a terminal for each picture (components/raw-picture.ts). Absent: the bridge path only. */
  onPicture?(header: PictureHeader): PictureTarget
  /** The raw path's display state (a rebase or rebuild never changes the connection status). */
  onDisplay?(state: DisplayState, detail?: Record<string, unknown>): void
  /** The raw path: the session's fidelity, as every picture header and rebuilding notice carries it (server-held, so a reconnect restates it). */
  onFidelity?(fidelity: Fidelity): void
  /** An ended raw-path session has no output to show (lib/socket.ts UnavailableReason); the client does not reconnect. */
  onUnavailable?(reason: UnavailableReason): void
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
  private connections = 0
  /** Which connection this is: sequences restart with each one, so a result means nothing without it. */
  get connection(): number { return this.connections }
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
  /** The raw path's picture on this connection (set by its first join). */
  private raw: RawPicture | undefined
  private retiredTotal = 0
  private retiredSent = 0
  private retireTimer: ReturnType<typeof setTimeout> | undefined

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
    this.connections++
    socket.onopen = () => { socket.send(JSON.stringify({ type: 'hello', clientId: this.options.clientId })) }
    socket.onmessage = (event) => { if (this.socket === socket) this.receive(event.data) }
    socket.onclose = (event) => { if (this.socket === socket) this.dropped(event.code, event.reason) }
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

  /**
   * Queue input for `generation`: the sequence of the envelope that carries
   * it on this connection (its result names it), or false when it cannot be
   * sent (not synced). A `paste` travels alone, after everything queued
   * before it; the server delivers it as tmux pastes (lib/paste.ts), then
   * Return if `enter`, only once the paste went.
   */
  input(generation: number, data: string, options: { paste?: boolean; enter?: boolean } = {}): number | false {
    if (!this.synced || !data) return false
    if (options.paste) {
      this.flush()
      return this.envelope(generation, data, options.enter ? { paste: true, enter: true } : { paste: true })
    }
    if (this.pending && this.pending.generation !== generation) this.flush()
    if (this.inFlight.size === 0 && !this.pending) return this.envelope(generation, data)
    this.pending = this.pending ? { generation, data: this.pending.data + data } : { generation, data }
    // Pending input travels in the next envelope.
    const carrier = this.viewerSeq + 1
    if (this.pending.data.length >= (this.options.coalesceBytes ?? 4096)) this.flush()
    else this.flushTimer ??= setTimeout(() => this.flush(), this.options.coalesceMs ?? 8)
    return carrier
  }

  /** Make this screen the session's size authority at `cols`×`rows`. */
  claim(cols: number, rows: number, device: ScreenDevice): boolean {
    if (!this.synced || !this.socket) return false
    this.socket.send(JSON.stringify({ type: 'claim', cols, rows, device }))
    return true
  }

  /** The authority's pane changed: follow it at the current size `epoch`. True when sent. */
  resize(epoch: number, cols: number, rows: number): boolean {
    if (!this.synced || !this.socket) return false
    this.socket.send(JSON.stringify({ type: 'resize', epoch, cols, rows }))
    return true
  }

  private envelope(generation: number, data: string, paste: { paste: true; enter?: true } | Record<string, never> = {}): number {
    const viewerSeq = ++this.viewerSeq
    this.inFlight.set(viewerSeq, generation)
    this.socket?.send(JSON.stringify({ type: 'input', generation, viewerSeq, data, ...paste }))
    return viewerSeq
  }

  private flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const pending = this.pending
    this.pending = undefined
    if (pending && this.synced) this.envelope(pending.generation, pending.data)
  }

  private receive(raw: unknown): void {
    if (raw instanceof ArrayBuffer && this.raw) { this.raw.binary(new Uint8Array(raw)); return }
    if (raw instanceof ArrayBuffer) {
      const bytes = new Uint8Array(raw)
      const epoch = this.epoch
      // A write finishing after a resync belongs to a discarded picture.
      this.options.onOutput(bytes, () => { if (epoch === this.epoch) this.written_(bytes.byteLength) })
      return
    }
    const text = String(raw)
    const message = JSON.parse(text) as { type: string } & Record<string, unknown>
    switch (message.type) {
      case 'join':
      case 'rebase':
        this.picture()?.message(message, text)
        if (message.fidelity) this.options.onFidelity?.(message.fidelity as Fidelity)
        this.options.onSession(message.session as Session)
        this.options.onPresence(presenceOf(message))
        return
      case 'layout':
      case 'geometry':
      case 'barrier':
        this.raw?.message(message, text)
        return
      // A rebuild can be told before the first picture (the join waits for the seed): still counted.
      case 'rebuilding':
        this.picture()?.message(message, text)
        if (message.fidelity) this.options.onFidelity?.(message.fidelity as Fidelity)
        return
      case 'sync':
        this.synced = true
        this.retry = 0
        this.epoch = Number(message.epoch)
        this.written = 0
        this.ackedSent = 0
        clearTimeout(this.ackTimer)
        this.ackTimer = undefined
        this.options.onSync(message as unknown as SyncMessage)
        this.options.onPresence(presenceOf(message))
        this.options.onStatus((message.session as Session).state === 'completed' ? 'Completed' : 'Connected')
        return
      case 'session': this.options.onSession(message.session as Session); return
      case 'presence': this.options.onPresence(presenceOf(message)); return
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
      // Someone else claimed in between; the pushed session already says who sizes.
      case 'size-refused': return
    }
  }

  /** The raw path's picture for this connection, made on its first join. */
  private picture(): RawPicture | undefined {
    if (this.raw || !this.options.onPicture) return this.raw
    const create = this.options.onPicture
    this.raw = new RawPicture({
      create,
      retired: (total) => this.retired(total),
      applied: (epoch) => {
        this.socket?.send(JSON.stringify({ type: 'replay-applied', epoch }))
        // The first applied replay lets input flow; later ones change only the display.
        if (!this.synced) {
          this.synced = true
          this.retry = 0
          this.options.onStatus('Connected')
        }
      },
      display: (state, detail) => this.options.onDisplay?.(state, detail),
      // A fresh connection joins with a fresh picture.
      failed: () => this.reconnect(),
    })
    return this.raw
  }

  /** Report the raw path's retired total, batched like ACKs. */
  private retired(total: number): void {
    this.retiredTotal = total
    if (total - this.retiredSent >= (this.options.ackBytes ?? 16 * 1024)) this.sendRetired()
    else this.retireTimer ??= setTimeout(() => this.sendRetired(), this.options.ackMs ?? 50)
  }

  private sendRetired(): void {
    clearTimeout(this.retireTimer)
    this.retireTimer = undefined
    if (this.retiredTotal === this.retiredSent) return
    this.retiredSent = this.retiredTotal
    this.socket?.send(JSON.stringify({ type: 'retired', bytes: this.retiredTotal }))
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
    this.raw?.close()
    this.raw = undefined
    this.retiredTotal = 0
    this.retiredSent = 0
    clearTimeout(this.retireTimer)
    this.retireTimer = undefined
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

  private dropped(code: number, reason?: string): void {
    this.lost()
    this.socket = undefined
    if (this.stopped) return
    if (code === 4005) {
      this.options.onStatus('Output unavailable')
      this.options.onUnavailable?.(reason === 'evicted' || reason === 'unreadable' ? reason : 'not-saved')
      return
    }
    const terminal = TERMINAL_CLOSES[code]
    if (terminal) { this.options.onStatus(terminal); return }
    const delays = this.options.reconnectMs ?? [500, 1000, 2000, 5000, 10000]
    this.options.onStatus('Reconnecting')
    this.retryTimer = setTimeout(() => this.connect(), delays[Math.min(this.retry, delays.length - 1)])
    this.retry++
  }
}

function presenceOf(message: Record<string, unknown>): Presence {
  return { sizeFrozen: Boolean(message.sizeFrozen), nativeClients: Number(message.nativeClients) || 0 }
}
