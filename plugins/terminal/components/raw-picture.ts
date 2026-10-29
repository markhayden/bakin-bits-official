/**
 * The browser side of the raw path's picture (spec D13, plan T33; the
 * server side is lib/raw-display.ts): a `join` or `rebase` header starts a
 * picture in a fresh terminal, its checkpoint text (`bytes` of UTF-8 in
 * binary frames, written as they come), then the side state, the tail,
 * and a `barrier`; live output and layouts follow. A `geometry` header (a
 * width change, plan T34a) is followed by its `bytes` of binary frames,
 * parsed into the target's scratch terminal and then installed.
 *
 * One ordered queue: writes go to xterm as they arrive (a geometry's to its
 * scratch terminal); the side state, a layout, a geometry's install and the
 * barrier each wait for every write before them, and nothing after them is
 * written until they ran; so does a `digest-point` (plan T37), answered with
 * the picture's digest as of its event. A new header cancels the queue.
 *
 * Every display frame is retired exactly once — applied, or discarded when
 * its picture is cancelled — and the total retired is what the server's
 * credit runs on. xterm runs a queued write's callback even after its
 * terminal is disposed, so a frame's own record (not the callback) decides.
 */
import type { CheckpointSideState } from '../lib/side-state'

/** A width change's picture from tmux, parsed into a scratch terminal of its size. */
export interface GeometrySink {
  write(data: Uint8Array, done: () => void): void
  /** Install its geometry into the picture's terminal (lib/geometry.ts): false when it cannot be. */
  install(): boolean
  discard(): void
}

/** Where a picture is drawn: a fresh terminal per header (components/terminal-canvas.tsx). */
export interface PictureTarget {
  write(data: Uint8Array, done: () => void): void
  resize(cols: number, rows: number): void
  /** A scratch terminal for a geometry of this size. */
  geometry(cols: number, rows: number): GeometrySink
  /** The checkpoint's text is parsed: set its side state. */
  finish(side: CheckpointSideState): void
  /** The replay is applied: side effects (bells, titles, offers) go live. */
  live(): void
  /** Cancelled (a newer picture replaced it before it was shown). */
  discard(): void
  /** The picture's digest now (lib/digest.ts, plan T37). */
  digest(): string
}

export interface PictureHeader {
  type: 'join' | 'rebase'
  epoch: number
  bytes: number
  checkpoint: CheckpointSideState & { cols: number; rows: number }
  [key: string]: unknown
}

/** What the display shows: joining (no picture yet), replaying a picture, live, or stale while the replica rebuilds. */
export type DisplayState = 'joining' | 'replaying' | 'live' | 'rebuilding'

export interface RawPictureOptions {
  /** Make the terminal for a picture (the previous one is discarded first, or shown until this one is live: the caller's choice). */
  create(header: PictureHeader): PictureTarget
  /** The total of display bytes retired so far (send it; batched by the caller). */
  retired(total: number): void
  /** The replay of `epoch` is applied (send replay-applied). */
  applied(epoch: number): void
  display(state: DisplayState, detail?: Record<string, unknown>): void
  /** The picture cannot follow the stream (a geometry it could not install): reconnect for a fresh one. */
  failed(reason: string): void
  /** The picture's digest at a server's point (plan T37): send it. */
  report(epoch: number, seq: number, digest: string): void
}

type Op =
  /** `into`: a geometry's scratch terminal instead of the picture's. */
  | { kind: 'write'; data: Uint8Array; bytes: number; done: boolean; into?: GeometrySink }
  | { kind: 'install'; sink: GeometrySink; bytes: number; done: boolean }
  | { kind: 'finish'; side: CheckpointSideState; done: boolean; bytes: 0 }
  | { kind: 'layout'; cols: number; rows: number; bytes: number; done: boolean }
  | { kind: 'barrier'; epoch: number; bytes: number; done: boolean }
  | { kind: 'notice'; detail: Record<string, unknown>; bytes: number; done: boolean }
  | { kind: 'digest'; epoch: number; seq: number; bytes: number; done: boolean }

const utf8Length = (text: string) => new TextEncoder().encode(text).length

export class RawPicture {
  private target: PictureTarget | undefined
  private epoch = 0
  /** Checkpoint text still to come for the current picture. */
  private text = 0
  private side: CheckpointSideState | undefined
  /** The geometry whose bytes are still coming, and how many. */
  private geometry: { sink: GeometrySink; bytes: number; header: number } | undefined
  /** Geometries made and not yet installed or discarded (one may still wait in the queue while the next comes). */
  private sinks = new Set<GeometrySink>()
  private queue: Op[] = []
  /** Writes submitted to xterm whose callbacks have not run. */
  private inflight = new Set<Op>()
  private total = 0
  private latched = false
  private state: DisplayState = 'joining'

  constructor(private options: RawPictureOptions) {}

  /** The first replay on this connection has been applied: input may flow (a rebase never takes it back). */
  get ready(): boolean { return this.latched }
  get display(): DisplayState { return this.state }

  /** A display message (JSON) as received; `raw` is its text (for its byte count). */
  message(message: Record<string, unknown> & { type: string }, raw: string): void {
    const bytes = utf8Length(raw)
    switch (message.type) {
      case 'join':
      case 'rebase': {
        this.cancel()
        const header = message as unknown as PictureHeader
        this.epoch = header.epoch
        this.text = header.bytes
        this.side = header.checkpoint
        this.target = this.options.create(header)
        this.retire(bytes)
        this.setState('replaying')
        if (this.text === 0) this.push({ kind: 'finish', side: header.checkpoint, done: false, bytes: 0 })
        return
      }
      case 'layout': this.push({ kind: 'layout', cols: Number(message.cols), rows: Number(message.rows), bytes, done: false }); return
      case 'barrier': this.push({ kind: 'barrier', epoch: Number(message.epoch), bytes, done: false }); return
      case 'geometry': {
        if (!this.target) { this.retire(bytes); return }
        const sink = this.target.geometry(Number(message.cols), Number(message.rows))
        this.sinks.add(sink)
        // Retired with its install (its bytes, as they are parsed).
        this.geometry = { sink, bytes: Number(message.bytes), header: bytes }
        if (this.geometry.bytes <= 0) this.installNext()
        return
      }
      // After every write before it: the picture as of that event.
      case 'digest-point': this.push({ kind: 'digest', epoch: Number(message.epoch), seq: Number(message.seq), bytes, done: false }); return
      // In order with the picture it is about: a barrier still waiting for its writes goes first.
      case 'rebuilding': this.push({ kind: 'notice', detail: { cause: message.cause, fidelity: message.fidelity }, bytes, done: false }); return
    }
  }

  /** A binary frame: checkpoint text while some is owed, a geometry's while its are, else output. */
  binary(data: Uint8Array): void {
    if (!this.target) { this.retire(data.byteLength); return }
    const geometry = this.text > 0 ? undefined : this.geometry
    this.push({ kind: 'write', data, bytes: data.byteLength, done: false, ...(geometry ? { into: geometry.sink } : {}) })
    if (geometry) {
      geometry.bytes -= data.byteLength
      if (geometry.bytes <= 0) this.installNext()
      return
    }
    if (this.text > 0) {
      this.text -= data.byteLength
      if (this.text <= 0) this.push({ kind: 'finish', side: this.side!, done: false, bytes: 0 })
    }
  }

  /** The geometry's bytes are all here: its install is queued after them. */
  private installNext(): void {
    const geometry = this.geometry!
    this.geometry = undefined
    this.push({ kind: 'install', sink: geometry.sink, bytes: geometry.header, done: false })
  }

  private dropGeometries(): void {
    for (const sink of this.sinks) sink.discard()
    this.sinks.clear()
    this.geometry = undefined
  }

  /** The connection is gone: drop the picture (its frames are moot; credit dies with the connection). */
  close(): void {
    for (const op of [...this.inflight, ...this.queue]) op.done = true
    this.inflight.clear()
    this.queue = []
    this.dropGeometries()
    this.target?.discard()
    this.target = undefined
  }

  private setState(state: DisplayState, detail?: Record<string, unknown>): void {
    this.state = state
    this.options.display(state, detail)
  }

  private retire(bytes: number): void {
    if (!bytes) return
    this.total += bytes
    this.options.retired(this.total)
  }

  /** A newer picture: everything queued for the old one is discarded (retired), its terminal dropped. */
  private cancel(): void {
    // Written but not yet called back, and not yet written: all of it is the old picture's.
    for (const op of [...this.inflight, ...this.queue]) if (!op.done) { op.done = true; this.retire(op.bytes) }
    // A geometry still receiving its bytes: its header is in no op yet.
    if (this.geometry) this.retire(this.geometry.header)
    this.inflight.clear()
    this.queue = []
    this.dropGeometries()
    this.target?.discard()
    this.target = undefined
  }

  private push(op: Op): void {
    this.queue.push(op)
    this.run()
  }

  /** Run what can run: writes are submitted in order; any other op waits for the writes before it. */
  private run(): void {
    while (this.queue.length) {
      const op = this.queue[0]!
      if (op.kind === 'write') {
        this.queue.shift()
        this.inflight.add(op)
        ;(op.into ?? this.target!).write(op.data, () => {
          // A cancelled picture's write: retired when it was discarded.
          if (op.done) return
          op.done = true
          this.inflight.delete(op)
          this.retire(op.bytes)
          this.run()
        })
        continue
      }
      if (this.inflight.size > 0) return
      this.queue.shift()
      op.done = true
      // A notice needs no terminal (it can come before the first picture).
      if (op.kind === 'notice') { this.retire(op.bytes); this.setState('rebuilding', op.detail); continue }
      const target = this.target!
      if (op.kind === 'digest') {
        this.retire(op.bytes)
        // A point of another picture (this one replaced it meanwhile) is not answered.
        if (op.epoch === this.epoch) this.options.report(op.epoch, op.seq, target.digest())
        continue
      }
      if (op.kind === 'install') {
        this.sinks.delete(op.sink)
        const installed = op.sink.install()
        op.sink.discard()
        this.retire(op.bytes)
        // The server installed it (only installed geometries are in the stream): a viewer that cannot is lost.
        if (!installed) { this.options.failed('geometry'); return }
        continue
      }
      if (op.kind === 'finish') target.finish(op.side)
      else if (op.kind === 'layout') { target.resize(op.cols, op.rows); this.retire(op.bytes) }
      else {
        this.retire(op.bytes)
        target.live()
        this.setState('live')
        this.latched = true
        this.options.applied(op.epoch)
      }
    }
  }
}
