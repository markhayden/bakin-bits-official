/**
 * One WebSocket per viewer (spec D8). Text frames are JSON control messages;
 * binary frames are terminal output.
 *
 * client → server: hello { clientId } (first, binds identity) · ack { epoch,
 *   bytes } (cumulative bytes written to xterm since that sync; acks for an
 *   older epoch are ignored) · input { generation, viewerSeq, data }
 *   · claim { cols, rows, device } (this screen sizes the session from now on) ·
 *   resize { epoch, cols, rows } (the claiming screen changed size; stale for
 *   anyone else or an older epoch) · pong
 * server → client: sync { epoch, session, snapshot, cursor } (atomic: the
 *   snapshot and the cursor it was taken at, plus generation, consumed input
 *   sequence and size on `session`, plus `sizeFrozen` and `nativeClients`)
 *   · binary output · session { session } · presence { sizeFrozen,
 *   nativeClients } (the sizing screen disconnected or came back — the size
 *   holds while it is away — or a terminal app attached or left) ·
 *   result { viewerSeq, status: accepted | rejected | uncertain, error? } ·
 *   ping · error { error }
 *
 * Flow control is application-level (the host has no send bound): output is
 * sent only while fewer than ACK_WINDOW bytes are unacknowledged (overshooting
 * by at most one stored chunk); a viewer
 * paused longer than PAUSE_EVICT_MS is closed so it reconnects and resyncs.
 * Input is never replayed by the server; a lost result is the client's
 * "may have been delivered".
 */
import { z } from 'zod'
import type { PluginSocket } from '@makinbakin/sdk/types'
import type { NativeClient } from './processes'
import { DeliveryUncertainError, screenDevice, TerminalError, type Principal, type Session, type SizeClaimant } from './contracts'

export const ACK_WINDOW = 256 * 1024
export const PAUSE_EVICT_MS = 10_000
export const HEARTBEAT_MS = 15_000
export const SILENCE_CLOSE_MS = 30_000
const FRAME_BYTES = 64 * 1024
const CLIENT_ID = /^[a-zA-Z0-9-]{16,100}$/

/** Close codes the client acts on. */
export const SOCKET_CLOSE = {
  resync: 4000,
  superseded: 4001,
  silent: 4002,
  protocol: 4003,
  notFound: 4004,
} as const

export interface ViewerManager {
  get(id: string, principal: Principal): Session
  screen(id: string, principal: Principal): Promise<{ session: Session; data: string; cursor: number }>
  outputPage(id: string, principal: Principal, cursor: number, limit?: number): { session: Session; cursor: number; data: Buffer; truncated: boolean }
  nextOutput(id: string, cursor: number, signal: AbortSignal): Promise<void>
  onSessionChange(id: string, listener: (session: Session) => void): () => void
  nativeClients(id: string): NativeClient[]
  onNatives(id: string, listener: () => void): () => void
  writeNext(id: string, principal: Principal, generation: number, data: string): Promise<Session>
  claim(id: string, principal: Principal, cols: number, rows: number, claimant: SizeClaimant): Promise<Session>
  resizeAs(id: string, principal: Principal, epoch: number, cols: number, rows: number): Promise<Session>
}

const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: z.string().regex(CLIENT_ID) }),
  z.object({ type: z.literal('ack'), epoch: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  z.object({ type: z.literal('input'), generation: z.number().int().nonnegative(), viewerSeq: z.number().int().positive(), data: z.string().max(65536) }),
  z.object({ type: z.literal('claim'), cols: z.number().int().min(1).max(400), rows: z.number().int().min(1).max(150), device: screenDevice }),
  z.object({ type: z.literal('resize'), epoch: z.number().int().nonnegative(), cols: z.number().int().min(1).max(400), rows: z.number().int().min(1).max(150) }),
  z.object({ type: z.literal('pong') }),
])

/** Live viewers by `${sessionId} ${clientId}`: a reconnect supersedes the old socket. */
const viewers = new Map<string, TerminalViewer>()

/** The sizing screen joined or left: every other viewer's header changes (frozen or live). */
function presenceChanged(sessionId: string, clientId: string): void {
  for (const [key, viewer] of viewers) if (key.startsWith(`${sessionId} `)) viewer.authorityMoved(clientId)
}

export class TerminalViewer {
  private principal: Principal | undefined
  private epoch = 0
  private cursor = 0
  private sent = 0
  private acked = 0
  private lastViewerSeq = 0
  private sentPresence: string | undefined
  private closed = false
  private wake: (() => void) | undefined
  private evict: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private lastHeard: number
  private unsubscribe: (() => void) | undefined
  private unsubscribeNatives: (() => void) | undefined
  private readonly abort = new AbortController()
  private static epochs = 0

  constructor(
    private manager: ViewerManager,
    private socket: PluginSocket,
    private sessionId: string,
    private options: { now?: () => number; ackWindow?: number; pauseEvictMs?: number; heartbeatMs?: number; silenceCloseMs?: number } = {},
  ) {
    this.lastHeard = this.now()
    socket.onMessage((data) => { void this.receive(data) })
    socket.onClose(() => this.dispose())
    this.heartbeat = setInterval(() => {
      if (this.now() - this.lastHeard > (this.options.silenceCloseMs ?? SILENCE_CLOSE_MS)) this.close(SOCKET_CLOSE.silent, 'No heartbeat')
      else this.send({ type: 'ping' })
    }, this.options.heartbeatMs ?? HEARTBEAT_MS)
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
  private send(payload: unknown): void { this.socket.send(JSON.stringify(payload)) }
  private close(code: number, reason: string): void {
    if (this.closed) return
    this.socket.close(code, reason)
    this.dispose()
  }
  private dispose(): void {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    clearTimeout(this.evict)
    clearInterval(this.heartbeat)
    this.unsubscribe?.()
    this.unsubscribeNatives?.()
    this.wake?.()
    if (this.principal) {
      const key = `${this.sessionId} ${this.principal.id}`
      if (viewers.get(key) === this) {
        viewers.delete(key)
        presenceChanged(this.sessionId, this.principal.id)
      }
    }
  }

  private async receive(raw: string | Uint8Array): Promise<void> {
    this.lastHeard = this.now()
    if (typeof raw !== 'string') { this.close(SOCKET_CLOSE.protocol, 'Binary frames are output only'); return }
    let parsed: z.infer<typeof message>
    try {
      parsed = message.parse(JSON.parse(raw))
    } catch {
      // A malformed frame means the client and server disagree on the protocol.
      this.close(SOCKET_CLOSE.protocol, 'Malformed message')
      return
    }
    if (!this.principal && parsed.type !== 'hello') { this.close(SOCKET_CLOSE.protocol, 'hello must come first'); return }
    switch (parsed.type) {
      case 'hello': return this.hello(parsed.clientId)
      case 'ack':
        // Bytes written before a resync belong to a picture the client has discarded.
        if (parsed.epoch !== this.epoch) return
        this.acked = Math.min(this.sent, Math.max(this.acked, parsed.bytes))
        if (this.sent - this.acked < this.window()) { clearTimeout(this.evict); this.evict = undefined; this.wake?.() }
        return
      case 'input': return this.input(parsed.generation, parsed.viewerSeq, parsed.data)
      case 'claim':
      case 'resize':
        try {
          if (parsed.type === 'claim') await this.manager.claim(this.sessionId, this.principal!, parsed.cols, parsed.rows, { kind: 'browser', device: parsed.device })
          else await this.manager.resizeAs(this.sessionId, this.principal!, parsed.epoch, parsed.cols, parsed.rows)
        } catch (error) {
          // A stale resize (someone else claimed) is normal: the pushed session says who sizes now.
          this.send({ type: 'size-refused', error: error instanceof Error ? error.message : 'Resize failed' })
        }
        return
      case 'pong': return
    }
  }

  private window(): number { return this.options.ackWindow ?? ACK_WINDOW }

  /** The size holds while the screen or terminal app that sizes it is not connected. */
  private frozen(session: Session): boolean {
    const authority = session.sizeAuthority
    if (authority?.kind === 'native') return !this.manager.nativeClients(session.id).some((client) => `native:${client.pid}` === authority.viewer)
    return authority?.kind === 'browser' && !viewers.has(`${session.id} ${authority.viewer}`)
  }

  private presenceOf(session: Session): { sizeFrozen: boolean; nativeClients: number } {
    return { sizeFrozen: this.frozen(session), nativeClients: this.manager.nativeClients(session.id).length }
  }

  /** Tell this viewer when the size freezes or thaws, or terminal apps come and go (only on change; sync carries the first value). */
  private presence(session: Session): void {
    const presence = this.presenceOf(session)
    const key = JSON.stringify(presence)
    if (key === this.sentPresence) return
    this.sentPresence = key
    this.send({ type: 'presence', ...presence })
  }

  /** A screen of this session connected or left: it may be the one that sizes it. */
  authorityMoved(clientId: string): void {
    if (this.principal?.id !== clientId) this.refreshPresence()
  }

  private refreshPresence(): void {
    if (!this.principal) return
    try { this.presence(this.manager.get(this.sessionId, this.principal)) }
    catch (error) { this.failed(error) }
  }

  private async hello(clientId: string): Promise<void> {
    if (this.principal) { this.close(SOCKET_CLOSE.protocol, 'hello was already sent'); return }
    const principal: Principal = { kind: 'human', id: clientId }
    try { this.manager.get(this.sessionId, principal) }
    catch { this.close(SOCKET_CLOSE.notFound, 'Session not found'); return }
    this.principal = principal
    const key = `${this.sessionId} ${clientId}`
    viewers.get(key)?.close(SOCKET_CLOSE.superseded, 'Reconnected elsewhere')
    viewers.set(key, this)
    presenceChanged(this.sessionId, clientId)
    this.unsubscribe = this.manager.onSessionChange(this.sessionId, (session) => {
      this.send({ type: 'session', session })
      this.presence(session)
    })
    this.unsubscribeNatives = this.manager.onNatives(this.sessionId, () => this.refreshPresence())
    if (await this.sync()) void this.pump()
  }

  /** A failure the client recovers from by reconnecting (404 only when the session is gone). */
  private failed(error: unknown): void {
    if (error instanceof TerminalError && error.status === 404) this.close(SOCKET_CLOSE.notFound, 'Session not found')
    else this.close(SOCKET_CLOSE.resync, 'Terminal attachment unavailable; reconnect')
  }

  /** The atomic resync: snapshot + the cursor it reflects, then output after it. False when it failed (socket closed). */
  private async sync(): Promise<boolean> {
    this.epoch = ++TerminalViewer.epochs
    this.sent = 0
    this.acked = 0
    try {
      const session = this.manager.get(this.sessionId, this.principal!)
      if (session.state === 'running') {
        const snapshot = await this.manager.screen(this.sessionId, this.principal!)
        this.cursor = snapshot.cursor
        const presence = this.presenceOf(snapshot.session)
        this.sentPresence = JSON.stringify(presence)
        this.send({ type: 'sync', epoch: this.epoch, session: snapshot.session, snapshot: Buffer.from(snapshot.data).toString('base64'), cursor: snapshot.cursor, ...presence })
      } else {
        // Ended sessions replay their retained output from the start.
        this.cursor = 0
        const presence = this.presenceOf(session)
        this.sentPresence = JSON.stringify(presence)
        this.send({ type: 'sync', epoch: this.epoch, session, snapshot: '', cursor: 0, ...presence })
      }
      return true
    } catch (error) {
      this.failed(error)
      return false
    }
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      if (this.sent - this.acked >= this.window()) {
        this.evict ??= setTimeout(() => this.close(SOCKET_CLOSE.resync, 'Viewer fell behind; resync'), this.options.pauseEvictMs ?? PAUSE_EVICT_MS)
        await new Promise<void>((resolve) => { this.wake = resolve })
        continue
      }
      let page: ReturnType<ViewerManager['outputPage']>
      // Never more than the window allows (beyond one stored chunk).
      try { page = this.manager.outputPage(this.sessionId, this.principal!, this.cursor, this.window() - (this.sent - this.acked)) }
      catch (error) { this.failed(error); return }
      if (page.truncated && page.session.state === 'running') {
        // Output rolled past this viewer: rebuild it from a fresh snapshot.
        if (!await this.sync()) return
        continue
      }
      if (!page.data.length) {
        if (page.session.state !== 'running') {
          // Nothing more will come for an ended session; stay quiet until it is deleted.
          await new Promise<void>((resolve) => { this.wake = resolve })
          continue
        }
        await this.manager.nextOutput(this.sessionId, this.cursor, this.abort.signal)
        continue
      }
      for (let offset = 0; offset < page.data.length; offset += FRAME_BYTES) {
        const chunk = page.data.subarray(offset, offset + FRAME_BYTES)
        if (!this.socket.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return
        this.sent += chunk.byteLength
      }
      this.cursor = page.cursor
    }
  }

  private async input(generation: number, viewerSeq: number, data: string): Promise<void> {
    if (viewerSeq !== this.lastViewerSeq + 1) {
      this.send({ type: 'result', viewerSeq, status: 'rejected', error: 'Input is out of order on this connection' })
      return
    }
    this.lastViewerSeq = viewerSeq
    try {
      await this.manager.writeNext(this.sessionId, this.principal!, generation, data)
      this.send({ type: 'result', viewerSeq, status: 'accepted' })
    } catch (error) {
      const status = error instanceof DeliveryUncertainError ? 'uncertain' : 'rejected'
      this.send({ type: 'result', viewerSeq, status, error: error instanceof TerminalError ? error.message : 'Input failed' })
    }
  }
}
