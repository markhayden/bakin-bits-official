/**
 * The browser side of the raw path's picture (spec D13, plan T33; the
 * server side is lib/raw-display.ts): a `join` or `rebase` header starts a
 * picture in a fresh terminal, its checkpoint text (`bytes` of UTF-8 in
 * binary frames, written as they come), then the side state, the tail,
 * and a `barrier`; live output and layouts follow.
 *
 * One ordered queue: writes go to xterm as they arrive; the side state, a
 * layout and the barrier each wait for every write before them, and nothing
 * after them is written until they ran. A new header cancels the queue.
 *
 * Every display frame is retired exactly once — applied, or discarded when
 * its picture is cancelled — and the total retired is what the server's
 * credit runs on. xterm runs a queued write's callback even after its
 * terminal is disposed, so a frame's own record (not the callback) decides.
 */
import type { CheckpointSideState } from '../lib/side-state'

/** Where a picture is drawn: a fresh terminal per header (components/terminal-canvas.tsx). */
export interface PictureTarget {
  write(data: Uint8Array, done: () => void): void
  resize(cols: number, rows: number): void
  /** The checkpoint's text is parsed: set its side state. */
  finish(side: CheckpointSideState): void
  /** The replay is applied: side effects (bells, titles, offers) go live. */
  live(): void
  /** Cancelled (a newer picture replaced it before it was shown). */
  discard(): void
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
}

type Op =
  | { kind: 'write'; data: Uint8Array; bytes: number; done: boolean }
  | { kind: 'finish'; side: CheckpointSideState; done: boolean; bytes: 0 }
  | { kind: 'layout'; cols: number; rows: number; bytes: number; done: boolean }
  | { kind: 'barrier'; epoch: number; bytes: number; done: boolean }
  | { kind: 'notice'; detail: Record<string, unknown>; bytes: number; done: boolean }

const utf8Length = (text: string) => new TextEncoder().encode(text).length

export class RawPicture {
  private target: PictureTarget | undefined
  private epoch = 0
  /** Checkpoint text still to come for the current picture. */
  private text = 0
  private side: CheckpointSideState | undefined
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
      // In order with the picture it is about: a barrier still waiting for its writes goes first.
      case 'rebuilding': this.push({ kind: 'notice', detail: { cause: message.cause, fidelity: message.fidelity }, bytes, done: false }); return
    }
  }

  /** A binary frame: checkpoint text while some is owed, else output. */
  binary(data: Uint8Array): void {
    if (!this.target) { this.retire(data.byteLength); return }
    this.push({ kind: 'write', data, bytes: data.byteLength, done: false })
    if (this.text > 0) {
      this.text -= data.byteLength
      if (this.text <= 0) this.push({ kind: 'finish', side: this.side!, done: false, bytes: 0 })
    }
  }

  /** The connection is gone: drop the picture (its frames are moot; credit dies with the connection). */
  close(): void {
    for (const op of [...this.inflight, ...this.queue]) op.done = true
    this.inflight.clear()
    this.queue = []
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
    this.inflight.clear()
    this.queue = []
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
        this.target!.write(op.data, () => {
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
