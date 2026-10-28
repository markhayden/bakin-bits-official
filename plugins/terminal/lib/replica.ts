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
 *   - `width`: a width change's geometry could not be installed (below).
 *   The skipped output is superseded by the seed: it never appears in a
 *   tail. Rebuilds start at most once per REBUILD_INTERVAL_MS per session,
 *   at once when output has been quiet for REBUILD_QUIET_MS, and one
 *   capture runs at a time in the process.
 * - **A width change** (plan T34a) is no rebuild: tmux and xterm reflow
 *   differently, so the emulator resizes as usual and asks for a `geometry`
 *   capture; every event meanwhile is applied. The capture lands in the log
 *   at its boundary, is parsed into a temporary emulator, and its geometry
 *   is installed into the live one (lib/geometry.ts), which keeps its parser
 *   and state; the event is committed to the tail for viewers. One capture
 *   at a time: width changes while one is out need one more (the newest
 *   generation). A geometry that cannot be installed (sizes disagree) is a
 *   `width` rebuild. While history is owed (an overload's), it is the screen
 *   alone, like every seed then. One nothing owes when it lands (a seed
 *   since covered its width change) is dropped; one of the screen alone
 *   landing on a picture with its history is asked for again in full.
 * - A parser failure or an invalid log ends it. The log's own overflow
 *   stays the last safeguard (recovery, T35).
 */
import headless from '@xterm/headless'
import { installGeometry } from './geometry'
import { checkpointSteps, type Checkpoint, CHECKPOINT_FORMAT, type CheckpointResult, pieces } from './checkpoint'
import { EVENT_OVERHEAD_BYTES, terminalSteps, textSteps } from './memory'
import type { LogConsumer, LogEvent } from './output-log'
import { SeedDeferred, type SeedScope } from './reseed'
import { applyTerminalProfile, TERMINAL_OPTIONS } from './terminal-profile'
import { internals, HAS_EXTENDED, type Term } from './terminal-state'
import { altEnteredCols, altEntry, guardParser, type patchLinkLifetime } from './xterm-fixes'

type LinkLifetime = ReturnType<typeof patchLinkLifetime>

export const CHECKPOINT_BYTES = 1024 * 1024
export const CHECKPOINT_IDLE_MS = 2000
export const MAX_TAIL_BYTES = 4 * 1024 * 1024
/** Events in the tail (layout changes carry no bytes) before the same rebuild. */
export const MAX_TAIL_EVENTS = 4096
/** Work per slice before yielding; one step is at most about 2 ms, so a slice stays under 8 ms. */
export const CHECKPOINT_SLICE_MS = 3
/** Backlog in the log that makes the replica rebuild from tmux (half the log's bound). */
export const MAX_BACKLOG_BYTES = 4 * 1024 * 1024
/** Rebuilds of one session start at most this often while output keeps coming. */
export const REBUILD_INTERVAL_MS = 1000
/**
 * While a seed is parsed, output keeps queuing in the log (MAX_QUEUED_BYTES,
 * 8 MiB, invalidates it): overload pressure gives the seed up only past
 * this. It gives a seed room to land under a flood, not a guarantee; what
 * makes it land is a small seed (an overload rebuild's is the screen alone).
 */
export const SEED_ABANDON_BYTES = 6 * 1024 * 1024
/**
 * Output quiet this long after an overload: the screen-only pictures it left
 * get their history back with one full seed (tmux kept what its own history
 * bound allows).
 */
export const HISTORY_QUIET_MS = 1000
/** Output quiet this long while waiting: rebuild at once (the flood is over). */
export const REBUILD_QUIET_MS = 100

export type RebuildCause = 'overload' | 'tail bound' | 'width'

/** Lifecycle facts for logs: never terminal contents. */
export type ReplicaDiagnostic =
  | { kind: 'rebuilding'; cause: RebuildCause; backlog: number; tailBytes: number }
  | { kind: 'rebuilt'; cause: RebuildCause; skippedBytes: number; fromSeq: number; toSeq: number; ms: number }
  | { kind: 'ended'; reason: string }
  | { kind: 'listener failed'; error: string }
  /** A seed applied whole: with the pane's history, or the screen alone (a flood's). */
  | { kind: 'seeded'; reason: string; history: boolean }
  /** A width change's geometry: installed, or refused (a `width` rebuild follows). */
  | { kind: 'geometry'; generation: number; installed: boolean; ms: number }

/** Runs one capture in the heavy-work queue (lib/reseed.ts ReseedOptions.attempt). */
export type CaptureTurn = <T>(capture: () => Promise<T>) => Promise<T>

export interface ReplicaOptions {
  /**
   * Ask tmux for a seed (lib/reseed.ts), each capture attempt through
   * `turn`: settles once the seed is queued in the log (or the capture
   * failed, which invalidates the log).
   */
  reseed(reason: string, turn: CaptureTurn, scope: SeedScope): Promise<unknown>
  /**
   * Ask tmux for its picture at a width change (lib/reseed.ts `geometry`):
   * settles once the `geometry` event is queued in the log, like `reseed`.
   */
  geometry(generation: number, turn: CaptureTurn, scope: SeedScope): Promise<unknown>
  diagnostic?(event: ReplicaDiagnostic): void
  /** Quiet time before a checkpoint is tried (CHECKPOINT_IDLE_MS). */
  idleMs?: number
  /** Quiet time before an overload's history is restored (HISTORY_QUIET_MS). */
  historyQuietMs?: number
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
  /** Width-change geometries installed. */
  geometries: number
  skippedBytes: number
}

/**
 * A join's starting point (spec D13, plan T33): the base checkpoint and its
 * seq, and an immutable snapshot of every event committed after it, through
 * `throughSeq` (the tail's last, or the base's own seq). A subscriber is
 * told of events after `throughSeq` only.
 */
export interface Cut {
  checkpoint: Checkpoint; baseSeq: number; tail: readonly LogEvent[]; throughSeq: number
  /** The picture carries the pane's history (false: a flood's screen-only seed, until the quiet restore). */
  history: boolean
}

/** Where a replica is: joinable (its cut), waiting for its first seed or a rebuild's, or ended. */
export type ReplicaState =
  | { kind: 'live'; cut: Cut }
  | { kind: 'seeding' }
  | { kind: 'rebuilding'; cause: RebuildCause }
  | { kind: 'ended'; reason: string }

/**
 * Told of a replica's changes after the state it subscribed at, in order.
 * Called synchronously and never awaited: keep each call bounded; a throw is
 * contained (logged as a diagnostic) and never reaches the replica.
 */
export interface ReplicaListener {
  /** An event committed to the tail (an event a rebuild interrupted is never told). */
  event(event: LogEvent): void
  /** Base and tail are gone until a seed. */
  rebuilding(cause: RebuildCause): void
  /** A seed was applied whole: `state()` has the new cut. */
  rebased(): void
  ended(reason: string): void
}

/** A heavy job given up while it waited for its turn. */
export class Cancelled extends Error {
  constructor() { super('cancelled before its turn') }
}
/**
 * Heavy replica work, one job at a time in the process, in order: a
 * checkpoint, or a capture from tmux. A job whose owner gave up while it
 * waited is skipped when its turn comes (it rejects with Cancelled).
 */
const jobs: (() => Promise<void>)[] = []
let pumping = false
let running = 0
function heavy<T>(run: () => Promise<T>, cancelled: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobs.push(async () => {
      if (cancelled()) { reject(new Cancelled()); return }
      running++
      try { resolve(await run()) } catch (error) { reject(error) } finally { running-- }
    })
    void pump()
  })
}
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (jobs.length) await jobs.shift()!()
  } finally {
    pumping = false
  }
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

function profileTerminal(cols: number, rows: number): { terminal: Term; links: LinkLifetime } {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
  const profile = applyTerminalProfile(terminal)
  profile.setLive(false)
  return { terminal, links: profile.links }
}

/** From the first rebuild to the seed applied whole (a seed overtaken while it is parsed does not end it). */
interface Episode { cause: RebuildCause; since: number; fromSeq: number; skippedBytes: number }

export class Replica implements LogConsumer {
  private term: Term | undefined
  private links: LinkLifetime | undefined
  private listeners = new Set<ReplicaListener>()
  /** A seed is being parsed (overload pressure lets it finish, within SEED_ABANDON_BYTES). */
  private seeding = false
  /** An overload left the picture without its history: a full seed is owed once output is quiet. */
  private historyPending = false
  private historyTimer: ReturnType<typeof setTimeout> | undefined
  private lastIngressAt = -Infinity
  /** Events the log has taken (told through `pressure`), handed over, and not yet applied: a restore waits for all of them. */
  private ingressEvents = 0
  private handedEvents = 0
  private applyingEvents = 0
  /** Whether the base carries the pane's history (a screen-only seed, and checkpoints of it, do not). */
  private baseHistory = true
  private parser: { readonly failed: boolean } | undefined
  private base: { checkpoint: Checkpoint; seq: number } | undefined
  private tail: LogEvent[] = []
  private tailBytes = 0
  private sinceAttempt = 0
  /** The last event applied to the emulator (ignored events do not count). */
  private appliedSeq = 0
  /** Counts every event taken, applied or skipped (a reader can tell the replica moved). */
  private taken = 0
  /** When the last event finished (applied or skipped). */
  private settledAt = -Infinity
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private work: Promise<unknown> = Promise.resolve()
  private failure: string | undefined
  /** Waiting for a seed. */
  private rebuilding: RebuildCause | undefined
  private episode: Episode | undefined
  /** Stops a checkpoint waiting for its turn: rebuilding or ending must not wait behind other sessions' work. */
  private interrupt: (() => void) | undefined
  private capturing = false
  private lastCaptureAt = -Infinity
  private captureTimer: ReturnType<typeof setTimeout> | undefined
  /** Width changes so far; the newest still without its geometry (0: none owed); the newest asked for. */
  private widthGeneration = 0
  private widthOwed = 0
  private widthAsked = 0
  readonly stats: ReplicaStats = { accepted: 0, rejected: {}, abandoned: 0, rebuilds: {}, seeds: {}, geometries: 0, skippedBytes: 0 }

  constructor(private options: ReplicaOptions) {}

  /** The emulator, once a seed arrived (read it between events only: see `read`). */
  get terminal(): Term | undefined { return this.term }
  get ended(): string | undefined { return this.failure }
  get tailSize(): number { return this.tailBytes }
  /**
   * What the replica holds (lib/memory.ts): its emulator, the base
   * checkpoint's text and the tail. Steps (run it sliced): an estimate read
   * across turns, never a view of the screen.
   */
  *retainedSteps(): Generator<void, number> {
    const terminal = this.term
    const base = this.base
    const fixed = this.tailBytes + this.tail.length * EVENT_OVERHEAD_BYTES
    return (terminal ? yield* terminalSteps(terminal) : 0) + (base ? yield* textSteps(base.checkpoint.data) : 0) + fixed
  }

  /** Sweep link orphans erased since the last sweep (lib/xterm-fixes.ts), sliced, between events: a walk must not race the parser. */
  maintain(): Promise<void> {
    return this.serial(async () => { if (this.links && this.links.orphans() > 0) await runSliced(this.links.sweepSteps()) })
  }
  /** A width change still waits for its geometry. */
  get geometryOwed(): boolean { return this.widthOwed !== 0 }
  /** Why the replica is waiting for a seed, while it is. */
  get rebuildCause(): RebuildCause | undefined { return this.rebuilding }
  /** Changes whenever the replica takes an event. */
  get activity(): number { return this.taken }
  /** Milliseconds since the last event finished (read it from `read`: no event is in flight there). */
  get quietMs(): number { return this.now() - this.settledAt }

  /** Where the replica is now; when live, its cut (an immutable snapshot of the tail). */
  state(): ReplicaState {
    if (this.failure) return { kind: 'ended', reason: this.failure }
    if (this.rebuilding) return { kind: 'rebuilding', cause: this.rebuilding }
    if (!this.base) return { kind: 'seeding' }
    const tail = this.tail.slice()
    return { kind: 'live', cut: { checkpoint: this.base.checkpoint, baseSeq: this.base.seq, tail, throughSeq: tail.at(-1)?.seq ?? this.base.seq, history: this.baseHistory } }
  }

  /** The live cut, or undefined while there is none (no seed yet, rebuilding, or ended). */
  cut(): Cut | undefined {
    const state = this.state()
    return state.kind === 'live' ? state.cut : undefined
  }

  /** The state now and every change after it, with no gap between (both taken in this turn). */
  subscribe(listener: ReplicaListener): { state: ReplicaState; unsubscribe(): void } {
    this.listeners.add(listener)
    return { state: this.state(), unsubscribe: () => { this.listeners.delete(listener) } }
  }

  private notify(call: (listener: ReplicaListener) => void): void {
    for (const listener of [...this.listeners]) {
      try { call(listener) } catch (error) {
        this.options.diagnostic?.({ kind: 'listener failed', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Ask for the first seed (through the heavy-work queue, like every capture). */
  start(): void {
    if (this.term || this.capturing || this.failure) return
    this.capturing = true
    void this.options.reseed('attach', this.turn(), 'full').catch(() => undefined).finally(() => this.captured())
  }

  event(event: LogEvent): Promise<void> {
    this.handedEvents++
    this.applyingEvents++
    return this.serial(async () => {
      try { await this.apply(event) } finally { this.settledAt = this.now(); this.applyingEvents-- }
    })
  }

  pressure(queuedOutputBytes: number): void {
    // Told on every event the log takes: that is ingress (quiet for a history restore counts from it).
    this.lastIngressAt = this.now()
    this.ingressEvents++
    this.armHistory()
    if (queuedOutputBytes < MAX_BACKLOG_BYTES || !this.term || this.failure) return
    // A seed being applied is let finish (its picture is what viewers wait for under a
    // flood), unless the log itself is near its bound: then it is given up like any work.
    if (this.seeding && queuedOutputBytes < SEED_ABANDON_BYTES) return
    this.rebuild('overload', queuedOutputBytes)
  }

  invalid(reason: string): void { this.end(`log invalid: ${reason}`) }

  close(): void { this.end('closed') }

  /** Settles once every event delivered so far is applied (and any checkpoint it started ran). */
  idle(): Promise<void> { return this.serial(async () => undefined) }

  /** Read the emulator between events (undefined while there is none). */
  read<T>(view: (terminal: Term) => T): Promise<T | undefined> {
    return this.serial(async () => this.term && this.base ? view(this.term) : undefined)
  }

  private now(): number { return this.options.now?.() ?? performance.now() }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.work.then(run)
    this.work = result.catch(() => undefined)
    return result
  }

  /** One capture in the heavy-work queue; the interval counts from when it starts. */
  private turn(): CaptureTurn {
    return (capture) => heavy(() => {
      this.lastCaptureAt = this.now()
      return capture()
    }, () => this.failure !== undefined)
  }

  private async apply(event: LogEvent): Promise<void> {
    if (this.failure) return
    this.taken++
    if (event.kind === 'seed') { await this.seed(event); return }
    // Before the first seed, or while rebuilding, output is not this replica's stream (a geometry is superseded too).
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
      if (this.tail.length > MAX_TAIL_EVENTS) { this.rebuild('tail bound', 0); return }
      if (width) { this.widthOwed = ++this.widthGeneration; this.askGeometry() }
      this.armIdle()
      return
    }
    if (event.kind === 'geometry') { await this.geometry(event); return }
    await this.write(event.bytes)
    // Rebuilding began while the bytes were parsed: they are superseded too.
    if (this.failure || !this.base || this.rebuilding) return
    this.push(event, event.bytes.length)
    this.sinceAttempt += event.bytes.length
    if (this.tailBytes > MAX_TAIL_BYTES || this.tail.length > MAX_TAIL_EVENTS) { this.rebuild('tail bound', 0); return }
    if (this.sinceAttempt >= CHECKPOINT_BYTES) await this.checkpoint()
    this.armIdle()
  }

  private push(event: LogEvent, bytes: number): void {
    this.tail.push(event)
    this.tailBytes += bytes
    this.notify((listener) => listener.event(event))
  }

  /** Install a width change's geometry (the event is the tail's, for viewers), or rebuild. */
  private async geometry(event: Extract<LogEvent, { kind: 'geometry' }>): Promise<void> {
    // Nothing owed: a seed since it was asked for has every width change before it (it supersedes this).
    if (!this.widthOwed) return
    // Asked for the screen alone while history was owed, landing on a picture with its history: it would take
    // that history away. Asked for again, in full (the capture's scope is the replica's state when it lands).
    if (!event.history && !this.historyPending) { this.widthAsked = 0; this.askGeometry(); return }
    const started = this.now()
    const terminal = this.term!
    const { terminal: source } = profileTerminal(event.cols, event.rows)
    try {
      const parser = guardParser(source, () => undefined)
      for (const piece of pieces([new TextDecoder().decode(event.bytes)])) {
        if (this.failure || this.term !== terminal || this.rebuilding) return
        await new Promise<void>((resolve) => source.write(piece, resolve))
      }
      // Overtaken while it was parsed (an overload): the rebuild's seed supersedes it.
      if (this.failure || this.term !== terminal || this.rebuilding) return
      const installed = !parser.failed && installGeometry(terminal, source)
      this.options.diagnostic?.({ kind: 'geometry', generation: event.generation, installed, ms: Math.round(this.now() - started) })
      if (!installed) { this.rebuild('width', 0); return }
    } finally {
      source.dispose()
    }
    this.stats.geometries++
    if (event.generation >= this.widthOwed) this.widthOwed = 0
    this.push(event, event.bytes.length)
    this.sinceAttempt += event.bytes.length
    if (this.tailBytes > MAX_TAIL_BYTES || this.tail.length > MAX_TAIL_EVENTS) { this.rebuild('tail bound', 0); return }
    // A picture with its history is large: a checkpoint compacts it out of the tail.
    if (this.sinceAttempt >= CHECKPOINT_BYTES) await this.checkpoint()
    this.armIdle()
  }

  /** Ask for the newest width change's geometry, when the capture slot is free. */
  private askGeometry(): void {
    if (!this.widthOwed || this.widthAsked >= this.widthOwed || this.capturing || this.rebuilding || this.failure || !this.base) return
    this.capturing = true
    this.widthAsked = this.widthOwed
    void this.options.geometry(this.widthOwed, this.turn(), this.historyPending ? 'screen' : 'full').catch(() => undefined).finally(() => this.captured())
  }

  /** A capture settled: the slot is free for whatever waited for it. */
  private captured(): void {
    this.capturing = false
    // A rebuild that began while the slot was held asked for no seed: ask now.
    if (this.rebuilding) this.scheduleCapture()
    else this.askGeometry()
  }

  private async seed(event: Extract<LogEvent, { kind: 'seed' }>): Promise<void> {
    this.seeding = true
    try { await this.applySeed(event) } finally { this.seeding = false }
  }

  private async applySeed(event: Extract<LogEvent, { kind: 'seed' }>): Promise<void> {
    this.term?.dispose()
    clearTimeout(this.idleTimer)
    const { terminal, links } = profileTerminal(event.cols, event.rows)
    this.term = terminal
    this.links = links
    this.parser = guardParser(terminal, () => undefined)
    this.base = undefined
    this.tail = []
    this.tailBytes = 0
    this.sinceAttempt = 0
    this.rebuilding = undefined
    clearTimeout(this.captureTimer)
    // Every width change before it is in the seed's picture (a later one asks again).
    this.widthOwed = 0
    this.widthAsked = this.widthGeneration
    this.stats.seeds[event.reason] = (this.stats.seeds[event.reason] ?? 0) + 1
    // The text, as a restore will parse it, in pieces (a seed can be megabytes).
    const data = [new TextDecoder().decode(event.bytes)]
    for (const piece of pieces(data)) {
      if (this.failure || this.term !== terminal || this.rebuilding) break
      await this.write(piece)
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
        altEntry: terminal.buffer.active.type === 'alternate' ? altEntry(terminal) ?? null : null,
      },
    }
    this.options.diagnostic?.({ kind: 'seeded', reason: event.reason, history: event.history })
    this.baseHistory = event.history
    if (event.history) { this.historyPending = false; clearTimeout(this.historyTimer) }
    // A screen-only picture: its history comes back once output is quiet, even if none follows.
    else this.armHistory()
    this.notify((listener) => listener.rebased())
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
    // An overload's pictures are the screen alone until output is quiet again.
    if (cause === 'overload') { this.historyPending = true; clearTimeout(this.historyTimer) }
    // The rebuild's seed is taken after every width change so far.
    this.widthOwed = 0
    this.widthAsked = this.widthGeneration
    this.base = undefined
    this.tail = []
    this.tailBytes = 0
    clearTimeout(this.idleTimer)
    this.interrupt?.()
    if (!this.episode) {
      this.episode = { cause, since: this.now(), fromSeq: this.appliedSeq + 1, skippedBytes: 0 }
      this.stats.rebuilds[cause] = (this.stats.rebuilds[cause] ?? 0) + 1
      this.options.diagnostic?.({ kind: 'rebuilding', cause, backlog, tailBytes })
    }
    // After the counts and the diagnostic: a listener reading the session's fidelity sees this rebuild.
    this.notify((listener) => listener.rebuilding(cause))
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
    // Settled, the seed is queued in the log and on its way (it ends the rebuild when it is applied);
    // a failed capture invalidates the log (lib/reseed.ts), which ends the replica. An overload's seed
    // is the screen alone: small enough to land while the flood goes on.
    // While history is owed (an overload's pictures), every rebuild seed is the screen alone: the
    // history comes back only with the quiet restore.
    void this.options.reseed(cause, this.turn(), this.historyPending ? 'screen' : 'full').catch(() => undefined).finally(() => this.captured())
  }

  /** (Re)start the quiet wait before a history restore, while one is owed. */
  private armHistory(): void {
    if (!this.historyPending || this.failure) return
    clearTimeout(this.historyTimer)
    this.historyTimer = setTimeout(() => this.restoreHistory(), this.options.historyQuietMs ?? HISTORY_QUIET_MS)
  }

  /**
   * Output has been quiet: one full seed through the log's ordered boundary
   * gives the picture its history back. The picture stays shown meanwhile
   * (this is not a rebuild); `historyPending` clears only when that seed lands.
   */
  private restoreHistory(): void {
    if (!this.historyPending || this.failure) return
    // (The slot is busy, e.g. a width change's geometry: wait for quiet again.)
    if (!this.restorable() || this.capturing) { this.armHistory(); return }
    this.capturing = true
    // Checked again when the capture gets its turn: output may have resumed while it waited.
    const turn = this.turn()
    const checked: CaptureTurn = (capture) => turn(async () => {
      if (!this.restorable()) throw new SeedDeferred('output resumed or the picture changed')
      return capture()
    })
    void this.options.reseed('history', checked, 'full')
      .catch((error) => { if (error instanceof SeedDeferred) this.armHistory() })
      .finally(() => this.captured())
  }

  private restorable(): boolean {
    const quiet = this.now() - this.lastIngressAt >= (this.options.historyQuietMs ?? HISTORY_QUIET_MS)
    // Caught up: nothing waits in the log or is being applied (a slow parse can outlast the quiet).
    const drained = this.handedEvents >= this.ingressEvents && this.applyingEvents === 0
    return quiet && drained && !this.failure && !this.rebuilding && !this.seeding && Boolean(this.base)
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.tail.length > 0) void this.serial(() => this.checkpoint()).catch(() => undefined)
    }, this.options.idleMs ?? CHECKPOINT_IDLE_MS)
  }

  private async checkpoint(): Promise<void> {
    const terminal = this.term
    if (this.failure || !terminal || !this.base || this.rebuilding) return
    const seq = this.appliedSeq
    // Overload is told at ingress: a checkpoint running is abandoned at its next slice, one still
    // waiting for its turn stops waiting at once (and is skipped when its turn comes).
    const stale = () => this.failure !== undefined || this.term !== terminal || this.rebuilding !== undefined
    const interrupted = new Promise<undefined>((resolve) => { this.interrupt = () => resolve(undefined) })
    const job = heavy(() => runSliced(checkpointSteps(terminal), stale), stale)
    job.catch(() => undefined)
    let result: CheckpointResult | undefined
    try {
      result = await Promise.race([job, interrupted])
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error
    } finally {
      this.interrupt = undefined
    }
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
    clearTimeout(this.historyTimer)
    clearTimeout(this.captureTimer)
    this.interrupt?.()
    this.rebuilding = undefined
    this.episode = undefined
    this.base = undefined
    this.tail = []
    this.tailBytes = 0
    this.term?.dispose()
    this.term = undefined
    this.options.diagnostic?.({ kind: 'ended', reason })
    this.notify((listener) => listener.ended(reason))
    this.listeners.clear()
  }
}
