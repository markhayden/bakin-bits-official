/**
 * One viewer's picture on the raw path (spec D13, plan T33): a join is the
 * replica's cut — its base checkpoint, then the tail snapshot, then a
 * barrier — and live events after it, all through one ordered sender.
 *
 * Frames (display frames; every one counts against the connection's credit):
 * - `join` / `rebase` header (JSON): the checkpoint's side state and `bytes`,
 *   the exact UTF-8 length of its text; then that text as binary frames;
 * - tail and live output as binary frames, `layout { seq, cols, rows }`;
 * - `barrier { epoch, throughSeq }`: the replay is complete;
 * - `rebuilding { cause, fidelity }`: the picture is stale until a rebase.
 * Once a header for an epoch is sent, nothing of an earlier epoch follows,
 * so binary frames need no epoch on the ordered socket.
 *
 * Credit is the connection's, never reset by a rebase: `sent` counts every
 * display frame's bytes, the client reports the total it has retired
 * (applied, or discarded as from an epoch it left). The stall eviction is
 * armed while outstanding bytes fill the window and cleared only by a
 * retirement that brings them below it.
 *
 * A replay in progress is never cancelled: a backlog overflow or a rebuild
 * during one only marks one pending replacement, taken from the replica's
 * latest cut once that replay's barrier is sent (at most once per
 * RESYNC_INTERVAL_MS). So every replay completes and the first one always
 * lets the viewer type (the latch is its `replay-applied`).
 */
import type { LogEvent } from './output-log'
import type { Cut, RebuildCause, ReplicaListener, ReplicaState } from './replica'
import type { Checkpoint } from './checkpoint'
import { EVENT_OVERHEAD_BYTES, textSteps } from './memory'
import { drain } from './terminal-state'

/** A viewer's backlog of events not yet sent (spec D8's viewer send queue). */
export const VIEWER_QUEUE_BYTES = 2 * 1024 * 1024
export const VIEWER_QUEUE_EVENTS = 4096
/** At most one picture replacement a second for a viewer. */
export const RESYNC_INTERVAL_MS = 1000
/** How long a join waits for its replica and the replica's first (or a rebuild's) seed, from the hello. */
export const JOIN_WAIT_MS = 10_000
/** The encoder's scratch while a checkpoint chunk is sent (at most three bytes a code unit). */
const ENCODER_SCRATCH_BYTES = 3 * 16 * 1024
/** Checkpoint text per binary frame, in UTF-16 code units (a surrogate pair is never split). */
const TEXT_CHUNK = 16 * 1024
const FRAME_BYTES = 64 * 1024

/**
 * The rebuilds a session's output has been through, by cause, and the last
 * (sticky for the session, spec D13 decision 1); `history` after an
 * overload: `incomplete` while the pictures are the screen alone,
 * `reloaded` once a full seed brought back what tmux kept.
 */
export interface Fidelity { rebuilds: Partial<Record<RebuildCause, number>>; lastCause?: RebuildCause; history?: 'incomplete' | 'reloaded' }

export interface RawSource {
  subscribe(listener: ReplicaListener): { state: ReplicaState; unsubscribe(): void }
  state(): ReplicaState
}

export interface DisplaySink {
  /** False once the socket is gone. */
  text(json: string): boolean
  binary(bytes: Uint8Array): boolean
}

export interface RawDisplayOptions {
  /** The rest of a header: the session and presence as the viewer sends them; undefined when that failed (the viewer has closed). */
  header(): Record<string, unknown> | undefined
  fidelity(): Fidelity
  /** The viewer must reconnect (it closes the socket with 4000). */
  resync(reason: string): void
  /** When a join that has no picture yet gives up (absolute, from the hello: Date.now() or `now`). */
  deadline: number
  window: number
  pauseEvictMs: number
  now?(): number
}

type Frame = { json: Record<string, unknown> } | { bytes: Uint8Array }

const encoder = new TextEncoder()
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** The checkpoint text as UTF-8, exactly as `checkpointText` will send it (pairs split across data strings joined). */
export function checkpointBytes(data: readonly string[]): number {
  let bytes = 0
  for (let i = 0; i < data.length; i++) {
    const text = data[i]!
    bytes += Buffer.byteLength(text, 'utf8')
    const next = data[i + 1]
    // A pair split across two strings: each half alone counts 3 bytes (a replacement), together 4.
    if (next && text.length && isHigh(text.charCodeAt(text.length - 1)) && isLow(next.charCodeAt(0))) bytes -= 2
  }
  return bytes
}

/** The checkpoint text in chunks of at most TEXT_CHUNK code units, never splitting a surrogate pair. */
export function* checkpointText(data: readonly string[]): Generator<Uint8Array> {
  let carry = ''
  for (const text of data) {
    for (let at = 0; at < text.length; at += TEXT_CHUNK) {
      let piece = carry + text.slice(at, at + TEXT_CHUNK)
      carry = ''
      if (piece.length && isHigh(piece.charCodeAt(piece.length - 1))) {
        carry = piece.slice(-1)
        piece = piece.slice(0, -1)
      }
      if (piece) yield encoder.encode(piece)
    }
  }
  if (carry) yield encoder.encode(carry)
}

function sideState(checkpoint: Checkpoint): Record<string, unknown> {
  return { format: checkpoint.format, cols: checkpoint.cols, rows: checkpoint.rows, scrollback: checkpoint.scrollback, joinState: checkpoint.joinState, penHasExtended: checkpoint.penHasExtended, altEnteredCols: checkpoint.altEnteredCols, altEntry: checkpoint.altEntry }
}

function* eventFrames(event: LogEvent): Generator<Frame> {
  if (event.kind === 'layout') { yield { json: { type: 'layout', seq: event.seq, cols: event.cols, rows: event.rows } }; return }
  if (event.kind !== 'output') return
  for (let at = 0; at < event.bytes.length; at += FRAME_BYTES) yield { bytes: event.bytes.subarray(at, at + FRAME_BYTES) }
}

export class RawDisplay implements ReplicaListener {
  private epoch = 0
  private sent = 0
  private retired = 0
  private replay: Generator<Frame> | undefined
  /** The rest of the live event being sent (an output event larger than a frame). */
  private live: Generator<Frame> | undefined
  private replaying: Cut | undefined
  /** The cut a replay generator holds until it is done (its barrier may wait for credit). */
  private pinned: Cut | undefined
  /** The replica's latest published cut, kept until a replacement takes it (one at most). */
  private latest: Cut | undefined
  /** The live event being sent, while its frames are. */
  private sending: LogEvent | undefined
  /** Live events after the current picture's cut, not yet sent. */
  private backlog: LogEvent[] = []
  private backlogBytes = 0
  /** A newer picture is owed (an overflow or a rebuild); taken once the replay in progress is sent. */
  private replacement = false
  private waitingForSeed = false
  private lastReplacementAt = -Infinity
  private replacementTimer: ReturnType<typeof setTimeout> | undefined
  private joinDeadline: ReturnType<typeof setTimeout> | undefined
  private evict: ReturnType<typeof setTimeout> | undefined
  private barriers = new Set<number>()
  private latch = false
  private closed = false
  private pumping = false
  private unsubscribe: (() => void) | undefined
  /** Control frames queued behind the replay (a rebuilding notice), in order. */
  private control: Record<string, unknown>[] = []

  constructor(private source: RawSource, private sink: DisplaySink, private options: RawDisplayOptions) {}

  /** The viewer may type: a replay it was sent has been applied (`replay-applied`). */
  get latched(): boolean { return this.latch }

  private now(): number { return this.options.now?.() ?? Date.now() }

  start(): void {
    const { state, unsubscribe } = this.source.subscribe(this)
    this.unsubscribe = unsubscribe
    if (state.kind === 'ended') { this.options.resync('Terminal output unavailable; reconnect'); return }
    // The wait for a seed is absolute from the hello: neither the replica arriving nor a rebuild notice extends it.
    this.joinDeadline = setTimeout(() => { if (this.epoch === 0) this.options.resync('Terminal output not ready; reconnect') }, Math.max(0, this.options.deadline - this.now()))
    if (state.kind === 'live') this.begin(state.cut, 'join')
    else this.waitingForSeed = true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    clearTimeout(this.replacementTimer)
    clearTimeout(this.joinDeadline)
    clearTimeout(this.evict)
    this.replay = undefined
    this.replaying = undefined
    this.pinned = undefined
    this.latest = undefined
    this.live = undefined
    this.sending = undefined
    this.control = []
    this.backlog = []
    this.backlogBytes = 0
  }

  /** The client has retired this many display bytes in all (cumulative). */
  retire(total: number): void {
    if (total <= this.retired) return
    this.retired = Math.min(total, this.sent)
    if (this.sent - this.retired < this.options.window) {
      clearTimeout(this.evict)
      this.evict = undefined
      this.pump()
    }
  }

  replayApplied(epoch: number): void {
    if (!this.barriers.has(epoch)) return
    this.latch = true
    clearTimeout(this.joinDeadline)
  }

  // ReplicaListener: synchronous and bounded.
  event(event: LogEvent): void {
    // A newer picture is owed: it will include this event.
    if (this.closed || this.waitingForSeed || this.replacement) return
    const bytes = event.kind === 'output' ? event.bytes.length : 0
    if (this.backlogBytes + bytes > VIEWER_QUEUE_BYTES || this.backlog.length >= VIEWER_QUEUE_EVENTS) {
      // Too far behind to catch up event by event: a newer picture replaces it (the replay in progress finishes first).
      this.dropBacklog()
      this.replacement = true
      if (!this.replaying) this.replaceSoon()
      return
    }
    this.backlog.push(event)
    this.backlogBytes += bytes
    this.pump()
  }

  rebuilding(cause: RebuildCause): void {
    if (this.closed) return
    // The picture is stale until a seed: what was queued for it is moot.
    this.dropBacklog()
    this.replacement = true
    this.waitingForSeed = true
    this.control.push({ type: 'rebuilding', cause, fidelity: this.options.fidelity() })
    this.pump()
  }

  rebased(): void {
    if (this.closed) return
    // Kept now: under a flood the replica may be rebuilding again when the throttle lets the viewer replace.
    const state = this.source.state()
    if (state.kind === 'live') this.latest = state.cut
    this.waitingForSeed = false
    this.replacement = true
    if (!this.replaying) this.replaceSoon()
  }

  ended(): void {
    if (!this.closed) this.options.resync('Terminal output ended; reconnect')
  }

  /** Events not yet started go; one already part sent finishes (its frames are on the wire). */
  private dropBacklog(): void {
    this.backlog = []
    this.backlogBytes = 0
  }

  /** Replace the picture with the replica's latest cut, at most once per RESYNC_INTERVAL_MS. */
  private replaceSoon(): void {
    // Only while a replacement is still owed; a replay in progress finishes first (its barrier asks again).
    if (this.closed || !this.replacement || this.replacementTimer || this.replaying) return
    // Waiting for a seed with no picture kept: the next `rebased` asks again.
    if (this.waitingForSeed && !this.latest) return
    const wait = this.lastReplacementAt + RESYNC_INTERVAL_MS - this.now()
    if (wait > 0) { this.replacementTimer = setTimeout(() => { this.replacementTimer = undefined; this.replaceSoon() }, wait); return }
    const state = this.source.state()
    if (state.kind === 'ended') { this.ended(); return }
    // The replica's cut now, or the latest one it published (it may be rebuilding again).
    const cut = state.kind === 'live' ? state.cut : this.latest
    if (!cut) { this.waitingForSeed = true; return }
    this.begin(cut, this.epoch === 0 ? 'join' : 'rebase')
  }

  private begin(cut: Cut, kind: 'join' | 'rebase'): void {
    this.latest = undefined
    this.epoch++
    this.replacement = false
    this.lastReplacementAt = this.now()
    // The cut includes every event committed so far: anything queued is in it, and older notices are superseded.
    this.dropBacklog()
    this.live = undefined
    this.sending = undefined
    this.control = []
    this.replaying = cut
    this.pinned = cut
    this.replay = this.frames(cut, kind, this.epoch)
    this.pump()
  }

  private *frames(cut: Cut, kind: 'join' | 'rebase', epoch: number): Generator<Frame> {
    const header = this.options.header()
    // The viewer could not describe the session (it is gone): nothing of this picture is sent.
    if (!header) { this.close(); return }
    // `history` is this picture's own (the session's fidelity may have moved on while it waited for credit).
    yield { json: { type: kind, epoch, ...header, fidelity: this.options.fidelity(), history: cut.history ? 'complete' : 'incomplete', checkpoint: sideState(cut.checkpoint), bytes: checkpointBytes(cut.checkpoint.data), baseSeq: cut.baseSeq, throughSeq: cut.throughSeq } }
    for (const bytes of checkpointText(cut.checkpoint.data)) yield { bytes }
    for (const event of cut.tail) yield* eventFrames(event)
    yield { json: { type: 'barrier', epoch, throughSeq: cut.throughSeq } }
  }

  /** Send frames while the window allows (overshooting by at most one frame). */
  private pump(): void {
    if (this.pumping || this.closed) return
    this.pumping = true
    try {
      while (!this.closed) {
        if (this.sent - this.retired >= this.options.window) {
          this.evict ??= setTimeout(() => this.options.resync('Viewer fell behind; resync'), this.options.pauseEvictMs)
          return
        }
        // A rebuilding notice goes out as soon as it is next in order: after a replay, before live events.
        let frame: Frame | undefined
        if (this.replay) {
          const next = this.replay.next()
          if (next.done) { this.replay = undefined; this.pinned = undefined; continue }
          frame = next.value
          if ('json' in frame && frame.json.type === 'barrier') {
            this.barriers.add(this.epoch)
            this.replaying = undefined
            queueMicrotask(() => this.replaceSoon())
          }
        } else if (this.control.length) {
          frame = { json: this.control.shift()! }
        } else {
          if (!this.live) {
            const event = this.backlog.shift()
            if (!event) return
            if (event.kind === 'output') this.backlogBytes -= event.bytes.length
            this.live = eventFrames(event)
            this.sending = event
          }
          const next = this.live.next()
          if (next.done) { this.live = undefined; this.sending = undefined; continue }
          frame = next.value
        }
        if (!this.send(frame)) { this.close(); return }
      }
    } finally {
      this.pumping = false
    }
  }

  private send(frame: Frame): boolean {
    if ('json' in frame) {
      const json = JSON.stringify(frame.json)
      this.sent += Buffer.byteLength(json, 'utf8')
      return this.sink.text(json)
    }
    this.sent += frame.bytes.byteLength
    return this.sink.binary(frame.bytes)
  }

  /**
   * What this viewer holds beyond the replica (lib/memory.ts): a replay's
   * cut while its generator is unfinished and the latest cut it keeps (each
   * one's checkpoint text when not the replica's base, and its tail), the
   * backlog and the event being sent, the encoder's scratch, bytes in flight.
   */
  *retainedSteps(): Generator<void, number> {
    let bytes = this.backlogBytes + this.backlog.length * EVENT_OVERHEAD_BYTES + (this.sent - this.retired)
    if (this.sending?.kind === 'output') bytes += this.sending.bytes.length + EVENT_OVERHEAD_BYTES
    if (this.pinned) bytes += ENCODER_SCRATCH_BYTES
    const current = this.source.state()
    const base = current.kind === 'live' ? current.cut.checkpoint : undefined
    // A replay's cut and the latest one kept: their text when not the replica's own base, and their tails.
    for (const cut of [this.pinned, this.latest]) {
      if (!cut) continue
      if (cut.checkpoint !== base) bytes += yield* textSteps(cut.checkpoint.data)
      for (const event of cut.tail) bytes += (event.kind === 'output' ? event.bytes.length : 0) + EVENT_OVERHEAD_BYTES
    }
    return bytes
  }
}

/** A drained reading of a display's retained bytes (tests). */
export const displayBytes = (display: RawDisplay): number => drain(display.retainedSteps())
