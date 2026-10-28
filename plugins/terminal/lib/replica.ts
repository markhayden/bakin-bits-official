/**
 * A session's server replica (spec D13, plan T32c): one headless emulator
 * built through the shared profile, fed by the session's event log in
 * order. It keeps what a join needs: the last accepted checkpoint (its
 * base) and every event after it (the tail).
 *
 * - It starts at a seed: events before the first seed are not its stream.
 *   A seed resets it, and is itself a base (the replica parsed exactly its
 *   text into a fresh emulator). Every seed is rebuilt from tmux, so it is
 *   degraded (lib/reseed.ts); its reason is counted in `stats.seeds`.
 * - Checkpoints are tried once CHECKPOINT_BYTES of output arrived since the
 *   last try, or after CHECKPOINT_IDLE_MS without output. At most one runs
 *   at a time in the process, in slices that yield to the event loop
 *   (input is never queued behind one); the replica takes no events
 *   meanwhile, so the log holds them.
 * - **Rebuilding from tmux** drops base and tail, ignores output (unparsed)
 *   until the next seed, and asks for one. Causes:
 *   - `overload`: the log's backlog reached MAX_BACKLOG_BYTES (tmux can
 *     deliver a flood about twice as fast as the replica parses it), told
 *     at ingress, so a checkpoint running or waiting is abandoned;
 *   - `tail bound`: no checkpoint accepted within MAX_TAIL_BYTES (an
 *     unterminated string, a state no bytes rebuild);
 *   - `width`: tmux and xterm reflow differently (T34a's rebase).
 *   The skipped output is superseded by the seed: it never appears in a
 *   tail. Rebuilds start at most once per REBUILD_INTERVAL_MS per session,
 *   at once when output has been quiet for REBUILD_QUIET_MS, and one
 *   capture runs at a time in the process.
 * - A parser failure or an invalid log ends it. The log's own overflow
 *   stays the last safeguard (recovery, T35).
 */
import headless from '@xterm/headless'
import { checkpointSteps, type Checkpoint, CHECKPOINT_FORMAT, type CheckpointResult, RESTORE_STEP_CHARS } from './checkpoint'
import type { LogConsumer, LogEvent } from './output-log'
import { applyTerminalProfile, TERMINAL_OPTIONS } from './terminal-profile'
import { internals, HAS_EXTENDED, type Term } from './terminal-state'
import { altEnteredCols, guardParser } from './xterm-fixes'

export const CHECKPOINT_BYTES = 1024 * 1024
export const CHECKPOINT_IDLE_MS = 2000
export const MAX_TAIL_BYTES = 4 * 1024 * 1024
/** Work per slice before yielding; one step is at most about 2 ms, so a slice stays under 8 ms. */
export const CHECKPOINT_SLICE_MS = 3
/** Backlog in the log that makes the replica rebuild from tmux (half the log's bound). */
export const MAX_BACKLOG_BYTES = 4 * 1024 * 1024
/** Rebuilds of one session start at most this often while output keeps coming. */
export const REBUILD_INTERVAL_MS = 1000
/** Output quiet this long while waiting: rebuild at once (the flood is over). */
export const REBUILD_QUIET_MS = 100

export type RebuildCause = 'overload' | 'tail bound' | 'width'

/** Lifecycle facts for logs: never terminal contents. */
export type ReplicaDiagnostic =
  | { kind: 'rebuilding'; cause: RebuildCause; backlog: number; tailBytes: number }
  | { kind: 'rebuilt'; cause: RebuildCause; skippedBytes: number; fromSeq: number; toSeq: number; ms: number }
  | { kind: 'ended'; reason: string }

export interface ReplicaOptions {
  /** Ask tmux for a seed (lib/reseed.ts): settles once the seed is queued in the log (or the capture failed). */
  reseed(reason: string): Promise<unknown>
  diagnostic?(event: ReplicaDiagnostic): void
  /** Quiet time before a checkpoint is tried (CHECKPOINT_IDLE_MS). */
  idleMs?: number
  now?(): number
}

/** What the replica has been through, for diagnostics and tests. */
export interface ReplicaStats {
  accepted: number
  rejected: Record<string, number>
  abandoned: number
  /** Rebuild episodes by the cause that began them (one lasts until a seed is applied whole). */
  rebuilds: Partial<Record<RebuildCause, number>>
  /** Seeds applied, by their reason. */
  seeds: Record<string, number>
  skippedBytes: number
}

/** A join's starting point: the base, and every event after it. */
export interface JoinPoint { checkpoint: Checkpoint; seq: number; tail: readonly LogEvent[] }

/** Heavy replica work, one at a time in the process: a checkpoint, or a capture from tmux. */
let slot: Promise<unknown> = Promise.resolve()
let running = 0
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const counted = async () => {
    running++
    try { return await run() } finally { running-- }
  }
  const result = slot.then(counted, counted)
  slot = result.catch(() => undefined)
  return result
}
/** Heavy replica work running now in this process (never more than one). */
export const heavyWorkRunning = (): number => running

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Run `steps` to the end in slices of `sliceMs`, yielding between them;
 * undefined when `abandon` says so before a step (the steps are closed).
 */
export async function runSliced<T>(steps: Generator<void, T>, abandon: () => boolean = () => false, sliceMs = CHECKPOINT_SLICE_MS): Promise<T | undefined> {
  try {
    if (abandon()) return undefined
    let started = performance.now()
    for (;;) {
      const next = steps.next()
      if (next.done) return next.value
      if (performance.now() - started < sliceMs) continue
      await nextTurn()
      if (abandon()) return undefined
      started = performance.now()
    }
  } finally {
    steps.return(undefined as never)
  }
}

function profileTerminal(cols: number, rows: number): Term {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
  applyTerminalProfile(terminal).setLive(false)
  return terminal
}

/** From the first rebuild to the seed applied whole (a seed overtaken while it is parsed does not end it). */
interface Episode { cause: RebuildCause; since: number; fromSeq: number; skippedBytes: number }

export class Replica implements LogConsumer {
  private term: Term | undefined
  private parser: { readonly failed: boolean } | undefined
  private base: { checkpoint: Checkpoint; seq: number } | undefined
  private tail: LogEvent[] = []
  private tailBytes = 0
  private sinceAttempt = 0
  /** The last event applied to the emulator (ignored events do not count). */
  private appliedSeq = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private work: Promise<void> = Promise.resolve()
  private failure: string | undefined
  /** Waiting for a seed. */
  private rebuilding: RebuildCause | undefined
  private episode: Episode | undefined
  private capturing = false
  private lastCaptureAt = -Infinity
  private captureTimer: ReturnType<typeof setTimeout> | undefined
  readonly stats: ReplicaStats = { accepted: 0, rejected: {}, abandoned: 0, rebuilds: {}, seeds: {}, skippedBytes: 0 }

  constructor(private options: ReplicaOptions) {}

  /** The emulator, once a seed arrived (read it between events only). */
  get terminal(): Term | undefined { return this.term }
  get ended(): string | undefined { return this.failure }
  get tailSize(): number { return this.tailBytes }
  /** Why the replica is waiting for a seed, while it is. */
  get rebuildCause(): RebuildCause | undefined { return this.rebuilding }

  /** Where a join starts, or undefined while there is none (no seed yet, or rebuilding). */
  joinPoint(): JoinPoint | undefined {
    return this.base && { ...this.base, tail: this.tail.slice() }
  }

  event(event: LogEvent): Promise<void> {
    return this.serial(() => this.apply(event))
  }

  pressure(queuedBytes: number): void {
    if (queuedBytes >= MAX_BACKLOG_BYTES && this.term && !this.failure) this.rebuild('overload', queuedBytes)
  }

  invalid(reason: string): void { this.end(`log invalid: ${reason}`) }

  close(): void { this.end('closed') }

  /** Settles once every event delivered so far is applied (and any checkpoint it started ran). */
  idle(): Promise<void> { return this.serial(async () => undefined) }

  private now(): number { return this.options.now?.() ?? performance.now() }

  private serial(run: () => Promise<void>): Promise<void> {
    const result = this.work.then(run)
    this.work = result.catch(() => undefined)
    return result
  }

  private async apply(event: LogEvent): Promise<void> {
    if (this.failure) return
    if (event.kind === 'seed') { await this.seed(event); return }
    // Before the first seed, or while rebuilding, output is not this replica's stream.
    if (this.rebuilding) {
      if (event.kind === 'output') this.skip(event.bytes.length)
      return
    }
    if (!this.base || !this.term) return
    this.appliedSeq = event.seq
    if (event.kind === 'layout') {
      const width = event.cols !== this.term.cols
      this.term.resize(event.cols, event.rows)
      this.push(event, 0)
      if (width) this.rebuild('width', 0)
      return
    }
    await this.write(event.bytes)
    // Rebuilding began while the bytes were parsed: they are superseded too.
    if (this.failure || !this.base || this.rebuilding) return
    this.push(event, event.bytes.length)
    this.sinceAttempt += event.bytes.length
    if (this.tailBytes > MAX_TAIL_BYTES) { this.rebuild('tail bound', 0); return }
    if (this.sinceAttempt >= CHECKPOINT_BYTES) await this.checkpoint()
    this.armIdle()
  }

  private push(event: LogEvent, bytes: number): void {
    this.tail.push(event)
    this.tailBytes += bytes
  }

  private async seed(event: Extract<LogEvent, { kind: 'seed' }>): Promise<void> {
    this.term?.dispose()
    clearTimeout(this.idleTimer)
    const terminal = profileTerminal(event.cols, event.rows)
    this.term = terminal
    this.parser = guardParser(terminal, () => undefined)
    this.base = undefined
    this.tail = []
    this.tailBytes = 0
    this.sinceAttempt = 0
    this.rebuilding = undefined
    clearTimeout(this.captureTimer)
    this.stats.seeds[event.reason] = (this.stats.seeds[event.reason] ?? 0) + 1
    // The text, as a restore will parse it, in pieces (a seed can be megabytes).
    const data = new TextDecoder().decode(event.bytes)
    for (let at = 0; at < data.length && !this.failure && this.term === terminal && !this.rebuilding;) {
      let end = Math.min(at + RESTORE_STEP_CHARS, data.length)
      const last = data.charCodeAt(end - 1)
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--
      await this.write(data.slice(at, end))
      at = end
    }
    // Overtaken while it was parsed: the episode stays open, and the next seed ends it.
    if (this.failure || this.term !== terminal || this.rebuilding) return
    this.appliedSeq = event.seq
    const handler = internals(terminal)._inputHandler
    this.base = {
      seq: event.seq,
      checkpoint: {
        format: CHECKPOINT_FORMAT, cols: event.cols, rows: event.rows, scrollback: TERMINAL_OPTIONS.scrollback, data,
        joinState: handler._parser.precedingJoinState,
        penHasExtended: (handler._curAttrData.bg & HAS_EXTENDED) !== 0,
        altEnteredCols: terminal.buffer.active.type === 'alternate' ? altEnteredCols(terminal) ?? null : null,
      },
    }
    const episode = this.episode
    this.episode = undefined
    if (episode) {
      this.options.diagnostic?.({ kind: 'rebuilt', cause: episode.cause, skippedBytes: episode.skippedBytes, fromSeq: episode.fromSeq, toSeq: event.seq, ms: Math.round(this.now() - episode.since) })
    }
  }

  private write(data: Uint8Array | string): Promise<void> {
    const terminal = this.term!
    return new Promise<void>((resolve) => terminal.write(data, () => {
      if (this.parser?.failed) this.end('parser failed')
      resolve()
    }))
  }

  /** Base and tail are gone: output is ignored until a seed, which is asked for. */
  private rebuild(cause: RebuildCause, backlog: number): void {
    if (this.rebuilding || this.failure) return
    const tailBytes = this.tailBytes
    this.rebuilding = cause
    this.base = undefined
    this.tail = []
    this.tailBytes = 0
    clearTimeout(this.idleTimer)
    if (!this.episode) {
      this.episode = { cause, since: this.now(), fromSeq: this.appliedSeq + 1, skippedBytes: 0 }
      this.stats.rebuilds[cause] = (this.stats.rebuilds[cause] ?? 0) + 1
      this.options.diagnostic?.({ kind: 'rebuilding', cause, backlog, tailBytes })
    }
    this.scheduleCapture()
  }

  private skip(bytes: number): void {
    this.episode!.skippedBytes += bytes
    this.stats.skippedBytes += bytes
    if (this.capturing) return
    if (this.now() - this.lastCaptureAt >= REBUILD_INTERVAL_MS) { this.capture(); return }
    // Output still coming: once it is quiet, rebuild without waiting out the interval.
    clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => this.capture(), REBUILD_QUIET_MS)
  }

  /** A capture now if the interval allows it, else once output is quiet or the interval ends. */
  private scheduleCapture(): void {
    if (this.capturing) return
    const wait = this.lastCaptureAt + REBUILD_INTERVAL_MS - this.now()
    if (wait <= 0) { this.capture(); return }
    clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => this.capture(), Math.min(wait, REBUILD_QUIET_MS))
  }

  private capture(): void {
    clearTimeout(this.captureTimer)
    this.captureTimer = undefined
    const cause = this.rebuilding
    if (!cause || this.capturing || this.failure) return
    this.capturing = true
    this.lastCaptureAt = this.now()
    // Settled, the seed is queued in the log and on its way (it ends the rebuild when it is applied);
    // a failed capture invalidates the log (lib/reseed.ts), which ends the replica.
    void exclusive(() => this.options.reseed(cause)).catch(() => undefined).finally(() => { this.capturing = false })
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.tailBytes > 0) void this.serial(() => this.checkpoint()).catch(() => undefined)
    }, this.options.idleMs ?? CHECKPOINT_IDLE_MS)
  }

  private async checkpoint(): Promise<void> {
    const terminal = this.term
    if (this.failure || !terminal || !this.base || this.rebuilding) return
    const seq = this.appliedSeq
    // Overload is told at ingress: a checkpoint running, or still waiting for its turn, is abandoned.
    const stale = () => this.failure !== undefined || this.term !== terminal || this.rebuilding !== undefined
    const result: CheckpointResult | undefined = await exclusive(() => runSliced(checkpointSteps(terminal), stale))
    if (stale() || !this.base || !result) {
      if (!this.failure) this.stats.abandoned++
      return
    }
    if ('rejected' in result) {
      const reason = result.rejected === 'parser not quiescent' ? result.rejected : 'state'
      this.stats.rejected[reason] = (this.stats.rejected[reason] ?? 0) + 1
      // Mid-sequence: the next event boundary is tried. A state no bytes rebuild waits for more output.
      if (reason === 'state') this.sinceAttempt = 0
      return
    }
    this.stats.accepted++
    this.base = { checkpoint: result.checkpoint, seq }
    this.tail = []
    this.tailBytes = 0
    this.sinceAttempt = 0
  }

  private end(reason: string): void {
    if (this.failure) return
    this.failure = reason
    clearTimeout(this.idleTimer)
    clearTimeout(this.captureTimer)
    this.rebuilding = undefined
    this.episode = undefined
    this.base = undefined
    this.tail = []
    this.tailBytes = 0
    this.term?.dispose()
    this.term = undefined
    this.options.diagnostic?.({ kind: 'ended', reason })
  }
}
