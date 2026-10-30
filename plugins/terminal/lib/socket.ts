/**
 * One WebSocket per viewer (spec D8). Text frames are JSON control messages;
 * binary frames are terminal output.
 *
 * client → server: hello { clientId } (first, binds identity) · input
 *   { generation, viewerSeq, data } · claim { cols, rows, device } (this
 *   screen sizes the session from now on) · resize { epoch, cols, rows } (the
 *   claiming screen changed size; stale for anyone else or an older epoch) ·
 *   retired { bytes } (every display byte applied or discarded, in all) ·
 *   replay-applied { epoch } · digest { epoch, seq, digest } · pong
 * server → client (lib/raw-display.ts, spec D13): join / rebase (the
 *   replica's checkpoint text, then its tail), barrier, layout, rebuilding,
 *   live output, digest-point · session { session } · presence { sizeFrozen,
 *   nativeClients } · result { viewerSeq, status: accepted | rejected |
 *   uncertain, error? } · size-refused · ping · error { error }
 *
 * Input is refused until the client's first replay is applied (a rebase never
 * takes that back). A session that stops running closes 4000: the reconnect
 * joins its saved final picture (or closes 4005 with why there is none).
 *
 * Flow control is application-level (the host has no send bound): the display
 * sends only while fewer than ACK_WINDOW bytes are unretired, and a viewer
 * paused longer than PAUSE_EVICT_MS is closed so it reconnects. Input is
 * never replayed by the server; a lost result is the client's "may have been
 * delivered".
 */
import { z } from 'zod'
import type { PluginSocket } from '@makinbakin/sdk/types'
import type { NativeClient, WriteOptions } from './processes'
import { type Fidelity, JOIN_WAIT_MS, RawDisplay, type RawSource } from './raw-display'
import { bundleSource, type Bundle } from './bundle'
import { DeliveryUncertainError, screenDevice, TerminalError, type Principal, type Session, type SizeClaimant } from './contracts'

export const ACK_WINDOW = 256 * 1024
export const PAUSE_EVICT_MS = 10_000
export const HEARTBEAT_MS = 15_000
export const SILENCE_CLOSE_MS = 30_000
const CLIENT_ID = /^[a-zA-Z0-9-]{16,100}$/

/** Close codes the client acts on. */
export const SOCKET_CLOSE = {
  resync: 4000,
  superseded: 4001,
  silent: 4002,
  protocol: 4003,
  notFound: 4004,
  /** An ended session's output is not there to show (plan T35b): the reason names why; final. */
  unavailable: 4005,
} as const

/** Why an ended session has no picture: the close reason of SOCKET_CLOSE.unavailable. */
export type UnavailableReason = 'not-saved' | 'evicted' | 'unreadable'

export interface ViewerManager {
  get(id: string, principal: Principal): Session
  onSessionChange(id: string, listener: (session: Session) => void): () => void
  nativeClients(id: string): NativeClient[]
  onNatives(id: string, listener: () => void): () => void
  writeNext(id: string, principal: Principal, generation: number, data: string, options?: WriteOptions): Promise<Session>
  claim(id: string, principal: Principal, cols: number, rows: number, claimant: SizeClaimant): Promise<Session>
  resizeAs(id: string, principal: Principal, epoch: number, cols: number, rows: number): Promise<Session>
  /** The session's replica, while attached. */
  replica(id: string): RawSource | undefined
  /** A viewer's picture repeatedly differed from the replica's (plan T37): rebuild it from tmux, logged. */
  diverged(id: string, detail: { category: string; seq: number; mismatches: number }): void
  /** Attach the session again if its replica was lost (before a join waits for it). */
  ensureReplica(id: string, principal: Principal): Promise<void>
  /** What the session's output has been through: rebuilds and recoveries (sticky). */
  fidelity(id: string): Fidelity
  /** An ended session's saved final output (lib/bundle.ts), if it can be read. */
  bundle(id: string): Promise<Bundle | undefined>
  /** Settles once the session's final save in flight, if any, has. */
  finalSaved(id: string): Promise<void>
}

const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: z.string().regex(CLIENT_ID) }),
  // `paste`: the data is one paste (lib/paste.ts), delivered as tmux pastes; `enter`: then Return, once it went.
  z.object({ type: z.literal('input'), generation: z.number().int().nonnegative(), viewerSeq: z.number().int().positive(), data: z.string().max(65536), paste: z.boolean().optional(), enter: z.boolean().optional() }),
  z.object({ type: z.literal('claim'), cols: z.number().int().min(1).max(400), rows: z.number().int().min(1).max(150), device: screenDevice }),
  z.object({ type: z.literal('resize'), epoch: z.number().int().nonnegative(), cols: z.number().int().min(1).max(400), rows: z.number().int().min(1).max(150) }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('retired'), bytes: z.number().int().nonnegative() }),
  z.object({ type: z.literal('replay-applied'), epoch: z.number().int().positive() }),
  z.object({ type: z.literal('digest'), epoch: z.number().int().positive(), seq: z.number().int().nonnegative(), digest: z.string().regex(/^[0-9a-f]{8}$/) }),
])

/** How often a live raw viewer's next digest point is considered (plan T37). */
export const DIGEST_TICK_MS = 1000
/** Replica output quiet this long is a quiet point. */
export const DIGEST_QUIET_MS = 1000
/** During output, a point at most this often. */
export const DIGEST_PERIOD_MS = 10_000
/** Mismatches per session within the window: each rejoins its viewer; the third escalates (once); more are left alone. */
export const DIGEST_WINDOW_MS = 10 * 60 * 1000
export const DIGEST_ESCALATE_AT = 3
/**
 * Recent digest mismatches by session, and its last escalation (a viewer's
 * rejoin must not reset them). Bounded: at most DIGEST_ESCALATE_AT times a
 * session, and sessions with nothing recent are dropped on every call.
 */
const mismatches = new Map<string, { recent: number[]; escalatedAt?: number }>()
/** How many sessions the digest bookkeeping holds (tests). */
export const digestSessionsTracked = (): number => mismatches.size
/** What a mismatch should do: rejoin the viewer, also escalate (once a window), or nothing more (bounded). */
export function digestMismatch(sessionId: string, now: number): 'rejoin' | 'escalate' | 'bounded' {
  for (const [id, entry] of mismatches) {
    entry.recent = entry.recent.filter((at) => now - at < DIGEST_WINDOW_MS)
    if (!entry.recent.length && (entry.escalatedAt === undefined || now - entry.escalatedAt >= DIGEST_WINDOW_MS) && id !== sessionId) mismatches.delete(id)
  }
  const entry = mismatches.get(sessionId) ?? { recent: [] }
  mismatches.set(sessionId, entry)
  // After an escalation, nothing more within the window (and nothing counts toward the next one).
  if (entry.escalatedAt !== undefined && now - entry.escalatedAt < DIGEST_WINDOW_MS) return 'bounded'
  entry.recent = [...entry.recent, now].slice(-DIGEST_ESCALATE_AT)
  if (entry.recent.length < DIGEST_ESCALATE_AT) return 'rejoin'
  entry.escalatedAt = now
  entry.recent = []
  return 'escalate'
}

/** How long a raw join waits for the session's replica and its seed, from the hello (lib/raw-display.ts JOIN_WAIT_MS). */
export const REPLICA_WAIT_MS = JOIN_WAIT_MS

/** Live viewers by `${sessionId} ${clientId}`: a reconnect supersedes the old socket. */
const viewers = new Map<string, TerminalViewer>()

/** What every raw viewer holds beyond the replicas (lib/memory.ts), for the memory reading. Steps: run it sliced. */
export function* viewersRetainedSteps(): Generator<void, number> {
  let total = 0
  for (const viewer of [...viewers.values()]) total += yield* viewer.retainedSteps()
  return total
}

/** The sizing screen joined or left: every other viewer's header changes (frozen or live). */
function presenceChanged(sessionId: string, clientId: string): void {
  for (const [key, viewer] of viewers) if (key.startsWith(`${sessionId} `)) viewer.authorityMoved(clientId)
}

export class TerminalViewer {
  private principal: Principal | undefined
  private lastViewerSeq = 0
  private sentPresence: string | undefined
  private closed = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private digestTimer: ReturnType<typeof setInterval> | undefined
  private lastPoint = { seq: -1, at: 0 }
  private lastHeard: number
  private unsubscribe: (() => void) | undefined
  private unsubscribeNatives: (() => void) | undefined
  /** This connection is a live session's join (set before its replica is waited for); false: an ended session's picture. */
  private live = false
  /** The picture, once its source is there. */
  private raw: RawDisplay | undefined

  constructor(
    private manager: ViewerManager,
    private socket: PluginSocket,
    private sessionId: string,
    private options: { now?: () => number; ackWindow?: number; pauseEvictMs?: number; heartbeatMs?: number; silenceCloseMs?: number; replicaWaitMs?: number; digestTickMs?: number; digestQuietMs?: number } = {},
  ) {
    this.lastHeard = this.now()
    socket.onMessage((data) => { this.receive(data).catch((error: unknown) => this.failed(error)) })
    socket.onClose(() => this.dispose())
    this.heartbeat = setInterval(() => {
      if (this.now() - this.lastHeard > (this.options.silenceCloseMs ?? SILENCE_CLOSE_MS)) this.close(SOCKET_CLOSE.silent, 'No heartbeat')
      else this.send({ type: 'ping' })
    }, this.options.heartbeatMs ?? HEARTBEAT_MS)
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
  *retainedSteps(): Generator<void, number> { return this.raw ? yield* this.raw.retainedSteps() : 0 }
  private send(payload: unknown): void { this.socket.send(JSON.stringify(payload)) }
  private close(code: number, reason: string): void {
    if (this.closed) return
    this.socket.close(code, reason)
    this.dispose()
  }
  private dispose(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    clearInterval(this.digestTimer)
    this.unsubscribe?.()
    this.unsubscribeNatives?.()
    this.raw?.close()
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
      case 'input': return this.input(parsed.generation, parsed.viewerSeq, parsed.data, { paste: parsed.paste ?? false, enter: (parsed.paste ?? false) && (parsed.enter ?? false) })
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
      case 'retired': this.raw?.retire(parsed.bytes); return
      case 'replay-applied': this.raw?.replayApplied(parsed.epoch); return
      case 'digest': this.digestReported(parsed.epoch, parsed.seq, parsed.digest); return
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

  /** Tell this viewer when the size freezes or thaws, or terminal apps come and go (only on change; the picture header carries the first value). */
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
      // A live picture ends with the session: the reconnect joins its saved final picture.
      if (this.live && session.state !== 'running') { this.close(SOCKET_CLOSE.resync, 'Session ended; reconnect'); return }
      this.send({ type: 'session', session })
      this.presence(session)
    })
    this.unsubscribeNatives = this.manager.onNatives(this.sessionId, () => this.refreshPresence())
    let session: Session
    try { session = this.manager.get(this.sessionId, principal) }
    catch (error) { this.failed(error); return }
    if (session.state === 'running') { this.live = true; await this.joinRaw(); return }
    // Ended: its saved final picture, or why there is none.
    await this.joinEnded(session)
  }

  /** A live session: wait (bounded) for the replica, then its picture (lib/raw-display.ts). */
  private async joinRaw(): Promise<void> {
    // One deadline from the hello for the replica and its seed together.
    const deadline = this.now() + (this.options.replicaWaitMs ?? REPLICA_WAIT_MS)
    // A lost replica (its control client closed, a failed reseed, a server restart) is attached again
    // first, within the same deadline: a recovery that takes longer is the reconnect's to retry.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), Math.max(0, deadline - this.now())) })
    try {
      const outcome = await Promise.race([this.manager.ensureReplica(this.sessionId, this.principal!), late])
      if (outcome === 'late') { if (!this.closed) this.close(SOCKET_CLOSE.resync, 'Terminal output not ready; reconnect'); return }
    } catch (error) { this.failed(error); return } finally { clearTimeout(timer) }
    if (this.closed) return
    let source = this.manager.replica(this.sessionId)
    while (!source && !this.closed && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      source = this.manager.replica(this.sessionId)
    }
    if (this.closed) return
    if (!source || this.now() >= deadline) { this.close(SOCKET_CLOSE.resync, 'Terminal output not ready; reconnect'); return }
    this.raw = new RawDisplay(source, {
      text: (json) => this.socket.send(json),
      binary: (bytes) => this.socket.send(bytes),
    }, {
      header: () => {
        try {
          const session = this.manager.get(this.sessionId, this.principal!)
          const presence = this.presenceOf(session)
          this.sentPresence = JSON.stringify(presence)
          return { session, ...presence }
        } catch (error) {
          // Gone: close now, before anything of the picture is sent.
          this.failed(error)
          return undefined
        }
      },
      fidelity: () => this.manager.fidelity(this.sessionId),
      resync: (reason) => this.close(SOCKET_CLOSE.resync, reason),
      deadline,
      window: this.window(),
      pauseEvictMs: this.options.pauseEvictMs ?? PAUSE_EVICT_MS,
      now: this.options.now,
    })
    this.raw.start()
    // Starting can close the viewer (an ended source): no timer outlives it.
    if (this.closed) return
    // The safety net (plan T37): points at quiet times and periodically during output.
    const replica = source
    if (replica.digest) this.digestTimer = setInterval(() => { void this.digestTick(replica) }, this.options.digestTickMs ?? DIGEST_TICK_MS)
  }

  private async digestTick(source: RawSource): Promise<void> {
    if (this.closed || !this.raw || !source.digest) return
    const now = this.now()
    const quiet = (source.quietMs ?? 0) >= (this.options.digestQuietMs ?? DIGEST_QUIET_MS)
    if (!quiet && now - this.lastPoint.at < DIGEST_PERIOD_MS) return
    const point = await source.digest()
    if (!point || point.seq === this.lastPoint.seq || this.closed) return
    if (this.raw.digestPoint(point.seq, point.digest)) this.lastPoint = { seq: point.seq, at: now }
  }

  private digestReported(epoch: number, seq: number, digest: string): void {
    if (this.raw?.digestReport(epoch, seq, digest) !== 'mismatch') return
    const action = digestMismatch(this.sessionId, this.now())
    if (action === 'bounded') return
    if (action === 'escalate') this.manager.diverged(this.sessionId, { category: 'viewer digest', seq, mismatches: DIGEST_ESCALATE_AT })
    // A fresh join (the replica's picture, or the rebuild's once it lands).
    this.close(SOCKET_CLOSE.resync, 'Display differed from the terminal; rejoin')
  }

  /** An ended session's final picture, joined like a live one; the session's own fidelity travels in the bundle. */
  private async joinEnded(ended: Session): Promise<void> {
    let session = ended
    // Not saved yet may be a save still in flight (a natural exit is published before its save ends): wait for it.
    if (!session.outputSaved) {
      // Within the join's deadline: a save that takes longer is the reconnect's to wait for.
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), this.options.replicaWaitMs ?? REPLICA_WAIT_MS) })
      const outcome = await Promise.race([this.manager.finalSaved(this.sessionId), late]).finally(() => clearTimeout(timer))
      if (this.closed) return
      if (outcome === 'late') { this.close(SOCKET_CLOSE.resync, 'Terminal output not ready; reconnect'); return }
      try { session = this.manager.get(this.sessionId, this.principal!) }
      catch (error) { this.failed(error); return }
    }
    // A bundle that cannot be read, or whose replay fails, is unreadable: final, never a resync loop.
    const bundle = session.outputSaved ? await this.manager.bundle(this.sessionId).catch(() => undefined) : undefined
    if (this.closed) return
    if (!bundle) {
      const reason: UnavailableReason = session.outputEvicted ? 'evicted' : session.outputSaved ? 'unreadable' : 'not-saved'
      this.close(SOCKET_CLOSE.unavailable, reason)
      return
    }
    try { this.startEnded(bundle) } catch {
      if (!this.closed) this.close(SOCKET_CLOSE.unavailable, 'unreadable')
    }
  }
  /** This viewer shows an ended session's saved picture. */
  private ended = false
  private startEnded(bundle: Bundle): void {
    this.ended = true
    this.raw = new RawDisplay(bundleSource(bundle), {
      text: (json) => this.socket.send(json),
      binary: (bytes) => this.socket.send(bytes),
    }, {
      header: () => {
        try {
          const current = this.manager.get(this.sessionId, this.principal!)
          const presence = this.presenceOf(current)
          this.sentPresence = JSON.stringify(presence)
          return { session: current, ...presence }
        } catch (error) {
          this.failed(error)
          return undefined
        }
      },
      fidelity: () => bundle.fidelity,
      // A stalled viewer is evicted to reconnect: it meets the same finished picture again.
      resync: (reason) => this.close(SOCKET_CLOSE.resync, reason),
      deadline: this.now() + (this.options.replicaWaitMs ?? REPLICA_WAIT_MS),
      window: this.window(),
      pauseEvictMs: this.options.pauseEvictMs ?? PAUSE_EVICT_MS,
      now: this.options.now,
    })
    this.raw.start()
  }

  /** A failure the client recovers from by reconnecting (404 only when the session is gone). */
  private failed(error: unknown): void {
    if (error instanceof TerminalError && error.status === 404) this.close(SOCKET_CLOSE.notFound, 'Session not found')
    // A finished picture that fails (now, or when credit resumes its replay) would fail again: final.
    else if (this.ended) this.close(SOCKET_CLOSE.unavailable, 'unreadable')
    else this.close(SOCKET_CLOSE.resync, 'Terminal attachment unavailable; reconnect')
  }

  private async input(generation: number, viewerSeq: number, data: string, options: WriteOptions): Promise<void> {
    // Nothing is typed before the first replay is applied (a rebase never re-gates).
    if (!this.raw?.latched) {
      this.send({ type: 'result', viewerSeq, status: 'rejected', error: 'Joining: input waits for the terminal to load' })
      return
    }
    if (viewerSeq !== this.lastViewerSeq + 1) {
      this.send({ type: 'result', viewerSeq, status: 'rejected', error: 'Input is out of order on this connection' })
      return
    }
    this.lastViewerSeq = viewerSeq
    try {
      await this.manager.writeNext(this.sessionId, this.principal!, generation, data, options)
      this.send({ type: 'result', viewerSeq, status: 'accepted' })
    } catch (error) {
      const status = error instanceof DeliveryUncertainError ? 'uncertain' : 'rejected'
      this.send({ type: 'result', viewerSeq, status, error: error instanceof TerminalError ? error.message : 'Input failed' })
    }
  }
}
