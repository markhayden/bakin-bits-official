import { describe, expect, it } from 'bun:test'
import { restoreCheckpoint } from '../lib/checkpoint'
import { BATCH_BYTES, type LogEvent } from '../lib/output-log'
import {
  CHECKPOINT_BYTES, heavyWorkRunning, MAX_BACKLOG_BYTES, SEED_ABANDON_BYTES, MAX_TAIL_BYTES, MAX_TAIL_EVENTS, REBUILD_INTERVAL_MS, REBUILD_QUIET_MS, Replica,
  type Cut, type ReplicaDiagnostic, runSliced,
} from '../lib/replica'
import { EVENT_OVERHEAD_BYTES, terminalBytes } from '../lib/memory'
import { SeedDeferred } from '../lib/reseed'
import { drain, fullState, stateDiff, type Term } from '../lib/terminal-state'
import { emulator, settled } from './helpers/terminal-fuzz'

const encode = (text: string) => new TextEncoder().encode(text)
async function until(check: () => boolean, label: string, ms = 3000): Promise<void> {
  for (const start = Date.now(); Date.now() - start < ms; await Bun.sleep(5)) if (check()) return
  throw new Error(`timed out: ${label}`)
}

/** A log's events, numbered like the log numbers them. */
function stream() {
  let seq = 0
  let offset = 0
  return {
    output(text: string | Uint8Array): LogEvent {
      const bytes = typeof text === 'string' ? encode(text) : text
      const event: LogEvent = { seq: ++seq, kind: 'output', offset, bytes }
      offset += bytes.length
      return event
    },
    layout: (cols: number, rows: number): LogEvent => ({ seq: ++seq, kind: 'layout', cols, rows }),
    seed: (text: string, cols: number, rows: number, history = true): LogEvent => ({ seq: ++seq, kind: 'seed', bytes: encode(text), cols, rows, reason: 'test', history }),
  }
}

function replica(options: Partial<ConstructorParameters<typeof Replica>[0]> = {}) {
  const reseeds: string[] = []
  const scopes: string[] = []
  const diagnostics: ReplicaDiagnostic[] = []
  // Captures take their turn in the heavy-work queue, as lib/reseed.ts does.
  const r = new Replica({ reseed: (reason, turn, scope) => turn(async () => { reseeds.push(reason); scopes.push(scope) }), diagnostic: (event) => diagnostics.push(event), ...options })
  const ended = () => diagnostics.flatMap((event) => event.kind === 'ended' ? [event.reason] : [])
  return { r, reseeds, scopes, diagnostics, ended }
}

/** A viewer's join: the base restored, then the tail. */
async function join(point: Cut): Promise<Term> {
  const { checkpoint } = point
  const viewer = emulator(checkpoint.cols, checkpoint.rows, checkpoint.scrollback)
  await restoreCheckpoint(viewer, checkpoint)
  for (const event of point.tail) {
    if (event.kind === 'output') viewer.write(event.bytes)
    else if (event.kind === 'layout') viewer.resize(event.cols, event.rows)
  }
  await settled(viewer)
  return viewer
}
async function expectJoinable(r: Replica): Promise<Cut> {
  const point = r.cut()
  expect(point).toBeDefined()
  const viewer = await join(point!)
  expect(stateDiff(fullState(viewer), fullState(r.terminal!))).toBeNull()
  viewer.dispose()
  return point!
}
/** Output as the log delivers it: events of at most BATCH_BYTES. */
async function deliver(r: Replica, s: ReturnType<typeof stream>, text: string): Promise<void> {
  const bytes = encode(text)
  for (let at = 0; at < bytes.length; at += BATCH_BYTES) await r.event(s.output(bytes.subarray(at, at + BATCH_BYTES)))
}
/** Lines of coloured text, `bytes` long or a little more. */
function flood(bytes: number, from = 0): string {
  let text = ''
  for (let i = from; text.length < bytes; i++) text += `\x1b[3${i % 8}mline ${i} ${'lorem ipsum dolor sit amet '.repeat(3)}\x1b[0m\r\n`
  return text
}

describe('Replica', () => {
  it('ignores events before its first seed; the seed is its first base', async () => {
    const s = stream()
    const { r } = replica()
    await r.event(s.output('before the seed'))
    expect(r.terminal).toBeUndefined()
    expect(r.cut()).toBeUndefined()
    await r.event(s.seed('\x1bc\x1b[1mseeded\x1b[0m\r\n$ ', 40, 10))
    await r.event(s.output('typed'))
    const point = await expectJoinable(r)
    expect(point.baseSeq).toBe(2)
    expect(point.tail.map((event) => event.seq)).toEqual([3])
    expect(r.terminal!.buffer.active.getLine(1)!.translateToString(true)).toBe('$ typed')
    r.close()
  })

  it('takes a checkpoint after CHECKPOINT_BYTES of output: the tail restarts after it', async () => {
    const s = stream()
    const { r } = replica()
    await r.event(s.seed('\x1bc', 120, 40))
    // Exactly CHECKPOINT_BYTES: the last event crosses it, and nothing follows.
    await deliver(r, s, flood(CHECKPOINT_BYTES).slice(0, CHECKPOINT_BYTES))
    expect(r.stats.accepted).toBe(1)
    const point = await expectJoinable(r)
    expect(point.tail).toEqual([])
    await r.event(s.output('after'))
    expect((await expectJoinable(r)).tail.length).toBe(1)
    r.close()
  })

  it('tries a checkpoint after the idle time', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 20 })
    await r.event(s.seed('\x1bc', 40, 10))
    await r.event(s.output('a little output'))
    expect(r.cut()!.tail.length).toBe(1)
    await Bun.sleep(60)
    await r.idle()
    expect(r.stats.accepted).toBe(1)
    expect((await expectJoinable(r)).tail).toEqual([])
    r.close()
  })

  it('retries at the next event while mid-sequence, and joins at any accepted point', async () => {
    const s = stream()
    const { r } = replica()
    await r.event(s.seed('\x1bc', 80, 24))
    // Every boundary but the last leaves the parser inside a CSI.
    const text = flood(CHECKPOINT_BYTES)
    await r.event(s.output(text + '\x1b[3'))
    await r.event(s.output('1mred'))
    expect(r.stats.rejected['parser not quiescent']).toBe(1)
    expect(r.stats.accepted).toBe(1)
    await expectJoinable(r)
    r.close()
  })

  it('bounds the tail: an unterminated string drops base and tail and asks for one reseed', async () => {
    const s = stream()
    const { r, reseeds } = replica()
    await r.event(s.seed('\x1bc', 80, 24))
    await r.event(s.output('\x1b]0;'))
    const payload = 'x'.repeat(65536)
    for (let sent = 0; sent <= MAX_TAIL_BYTES; sent += payload.length) await r.event(s.output(payload))
    expect(r.cut()).toBeUndefined()
    expect(reseeds).toEqual(['tail bound'])
    expect(r.tailSize).toBe(0)
    // Output while waiting is not kept; the next seed is the next base.
    await r.event(s.output(payload))
    expect(r.tailSize).toBe(0)
    expect(reseeds).toEqual(['tail bound'])
    await r.event(s.seed('\x1bcrecovered', 80, 24))
    await expectJoinable(r)
    expect(r.stats.rejected['parser not quiescent']).toBeGreaterThan(0)
    expect(r.stats.seeds).toEqual({ test: 2 })
    r.close()
  })

  it('a width change asks for a reseed; a row change is an ordered tail event', async () => {
    const s = stream()
    const { r, reseeds } = replica()
    await r.event(s.seed('\x1bc', 80, 24))
    await r.event(s.output('hello'))
    await r.event(s.layout(80, 30))
    await r.event(s.output('\r\nworld'))
    const point = await expectJoinable(r)
    expect(point.tail.map((event) => event.kind)).toEqual(['output', 'layout', 'output'])
    expect(reseeds).toEqual([])
    await r.event(s.layout(100, 30))
    expect(reseeds).toEqual(['width'])
    expect(r.cut()).toBeUndefined()
    r.close()
  })

  it('overload is told at ingress: a running checkpoint is abandoned, output is skipped unparsed, and the seed supersedes it', async () => {
    const s = stream()
    const { r, reseeds, diagnostics } = replica()
    await r.event(s.seed('\x1bc', 120, 40))
    // Scrollback makes the checkpoint long enough to be overtaken.
    await deliver(r, s, flood(2 * 1024 * 1024))
    const abandoned = r.stats.abandoned
    const pending = deliver(r, s, flood(CHECKPOINT_BYTES))
    for (let tries = 0; tries < 400 && heavyWorkRunning() === 0; tries++) await Bun.sleep(1)
    expect(heavyWorkRunning()).toBe(1)
    // The log, at ingress: the backlog reached the bound.
    r.pressure(MAX_BACKLOG_BYTES)
    await pending
    expect(r.stats.abandoned).toBe(abandoned + 1)
    expect(r.rebuildCause).toBe('overload')
    // The capture takes its turn once the abandoned checkpoint gives the slot up (at its next slice).
    for (let tries = 0; tries < 200 && reseeds.length === 0; tries++) await Bun.sleep(1)
    expect(reseeds).toEqual(['overload'])
    expect(r.cut()).toBeUndefined()
    // Output while rebuilding is skipped, not parsed.
    const before = r.stats.skippedBytes
    const parsed = r.terminal!.buffer.normal.length
    await r.event(s.output(flood(65536)))
    expect(r.stats.skippedBytes).toBeGreaterThan(before)
    expect(r.terminal!.buffer.normal.length).toBe(parsed)
    const seed = s.seed('\x1bcafter the flood', 120, 40)
    await r.event(seed)
    await r.event(s.output('\r\nnext'))
    expect(r.rebuildCause).toBeUndefined()
    const point = await expectJoinable(r)
    expect(point.baseSeq).toBe(seed.seq)
    expect(point.tail.map((event) => event.seq)).toEqual([seed.seq + 1])
    const rebuilt = diagnostics.find((event) => event.kind === 'rebuilt')
    expect(rebuilt).toMatchObject({ kind: 'rebuilt', cause: 'overload', toSeq: seed.seq })
    expect(rebuilt && rebuilt.kind === 'rebuilt' && rebuilt.skippedBytes).toBeGreaterThan(0)
    expect(diagnostics.find((event) => event.kind === 'rebuilding')).toMatchObject({ cause: 'overload', backlog: MAX_BACKLOG_BYTES })
    r.close()
  }, 30_000)

  it('a checkpoint still waiting for its turn is abandoned by overload', async () => {
    const s1 = stream()
    const s2 = stream()
    // A capture holds the one slot until the test lets it go.
    let release = () => {}
    const holder = replica({ reseed: (_reason, turn) => turn(() => new Promise<void>((resolve) => { release = resolve })) })
    const b = replica()
    await holder.r.event(s1.seed('\x1bc', 40, 10))
    await b.r.event(s2.seed('\x1bc', 120, 40))
    holder.r.pressure(MAX_BACKLOG_BYTES)
    await Bun.sleep(0)
    expect(heavyWorkRunning()).toBe(1)
    const pending = deliver(b.r, s2, flood(CHECKPOINT_BYTES).slice(0, CHECKPOINT_BYTES))
    // The last event is in the tail: b's checkpoint is waiting for the slot.
    for (let tries = 0; tries < 2000 && b.r.tailSize < CHECKPOINT_BYTES; tries++) await Bun.sleep(1)
    expect(b.r.tailSize).toBe(CHECKPOINT_BYTES)
    b.r.pressure(MAX_BACKLOG_BYTES)
    // Its delivery is released at once, though the slot is still held: the log drains.
    await pending
    expect(heavyWorkRunning()).toBe(1)
    await b.r.event(s2.output('skipped'))
    expect(b.r.stats.skippedBytes).toBe('skipped'.length)
    release()
    await Bun.sleep(0)
    expect(b.r.stats.accepted).toBe(0)
    expect(b.r.stats.abandoned).toBe(1)
    await Bun.sleep(0)
    expect(b.reseeds).toEqual(['overload'])
    holder.r.close()
    b.r.close()
  }, 30_000)

  it('rebuilds start at most once per interval while output keeps coming, and at once when it goes quiet', async () => {
    let now = 0
    const s = stream()
    const { r, reseeds } = replica({ now: () => now })
    await r.event(s.seed('\x1bc', 80, 24))
    r.pressure(MAX_BACKLOG_BYTES)
    await Bun.sleep(0)
    expect(reseeds).toEqual(['overload'])
    await r.event(s.seed('\x1bc', 80, 24))
    // Overloaded again straight away: no second capture inside the interval while output flows.
    now += 10
    r.pressure(MAX_BACKLOG_BYTES)
    for (let i = 0; i < 5; i++) { await r.event(s.output('x'.repeat(1000))); await Bun.sleep(REBUILD_QUIET_MS / 4) }
    expect(reseeds).toEqual(['overload'])
    // The interval passes with output still coming: the next skipped event captures.
    now += REBUILD_INTERVAL_MS
    await r.event(s.output('x'))
    await Bun.sleep(0)
    expect(reseeds).toEqual(['overload', 'overload'])
    await Bun.sleep(0)
    await r.event(s.seed('\x1bc', 80, 24))
    // Overloaded again, then quiet: captured after REBUILD_QUIET_MS without waiting out the interval.
    now += 10
    r.pressure(MAX_BACKLOG_BYTES)
    await r.event(s.output('x'))
    expect(reseeds.length).toBe(2)
    await Bun.sleep(REBUILD_QUIET_MS * 2)
    expect(reseeds.length).toBe(3)
    r.close()
  })

  it('a seed under a flood is let finish (its picture is what viewers wait for), and is given up only near the log bound', async () => {
    const s = stream()
    const { r, reseeds } = replica()
    await r.event(s.seed('\x1bc', 80, 24))
    // Pressure while the seed is parsed: the seed lands whole, its picture joinable.
    const big = s.seed('\x1bc' + flood(2 * 1024 * 1024), 80, 24)
    const pending = r.event(big)
    await Bun.sleep(5)
    r.pressure(MAX_BACKLOG_BYTES)
    await pending
    expect(r.cut()?.baseSeq).toBe(big.seq)
    expect(reseeds).toEqual([])
    // Near the log's own bound, the seed is given up like any work.
    const second = s.seed('\x1bc' + flood(2 * 1024 * 1024), 80, 24)
    const abandoned = r.event(second)
    await Bun.sleep(5)
    r.pressure(SEED_ABANDON_BYTES)
    await abandoned
    expect(r.cut()).toBeUndefined()
    expect(r.rebuildCause).toBe('overload')
    expect(reseeds).toEqual(['overload'])
    r.close()
  })

  it('a checkpoint over full scrollback yields to the event loop between slices', async () => {
    const s = stream()
    const { r } = replica()
    await r.event(s.seed('\x1bc', 120, 40))
    await deliver(r, s, flood(4 * 1024 * 1024))
    expect(r.terminal!.buffer.normal.length).toBe(10_000 + 40)
    // Turns the event loop takes while the checkpoint runs (the absolute gate is local: replica.integration.test.ts).
    let turns = 0
    const probe = () => { if (heavyWorkRunning()) turns++; if (probing) setImmediate(probe) }
    let probing = true
    setImmediate(probe)
    const accepted = r.stats.accepted
    await deliver(r, s, flood(CHECKPOINT_BYTES))
    probing = false
    expect(r.stats.accepted).toBe(accepted + 1)
    expect(turns).toBeGreaterThan(5)
    r.close()
  }, 30_000)

  it('the interval counts from when a capture starts, not from when it was asked for', async () => {
    let now = 0
    let release = () => {}
    const holder = replica({ reseed: (_reason, turn) => turn(() => new Promise<void>((resolve) => { release = resolve })) })
    const s1 = stream()
    const s2 = stream()
    const { r, reseeds } = replica({ now: () => now })
    await holder.r.event(s1.seed('\x1bc', 40, 10))
    await r.event(s2.seed('\x1bc', 40, 10))
    holder.r.pressure(MAX_BACKLOG_BYTES)
    await Bun.sleep(0)
    r.pressure(MAX_BACKLOG_BYTES)
    // Asked for at 0, waiting behind the held slot; it starts at 5000.
    now = 5000
    release()
    await Bun.sleep(0)
    expect(reseeds).toEqual(['overload'])
    await r.event(s2.seed('\x1bc', 40, 10))
    now = 5010
    r.pressure(MAX_BACKLOG_BYTES)
    await r.event(s2.output('x'))
    await Bun.sleep(0)
    // Inside the interval from the real start: no second capture yet.
    expect(reseeds).toEqual(['overload'])
    holder.r.close()
    r.close()
  })

  it('the first seed is asked for through the heavy-work queue', async () => {
    let release = () => {}
    const holder = replica({ reseed: (_reason, turn) => turn(() => new Promise<void>((resolve) => { release = resolve })) })
    const s1 = stream()
    await holder.r.event(s1.seed('\x1bc', 40, 10))
    holder.r.pressure(MAX_BACKLOG_BYTES)
    await Bun.sleep(0)
    const { r, reseeds } = replica()
    r.start()
    await Bun.sleep(5)
    expect(reseeds).toEqual([])
    release()
    await Bun.sleep(0)
    expect(reseeds).toEqual(['attach'])
    holder.r.close()
    r.close()
  })

  it('bounds a tail of layout changes by count, and checkpoints one when idle', async () => {
    const s = stream()
    const { r, reseeds } = replica({ idleMs: 20 })
    await r.event(s.seed('\x1bc', 80, 24))
    await r.event(s.layout(80, 30))
    await r.event(s.layout(80, 31))
    await Bun.sleep(60)
    await r.idle()
    expect(r.stats.accepted).toBe(1)
    expect(r.cut()!.tail).toEqual([])
    for (let i = 0; i <= MAX_TAIL_EVENTS; i++) await r.event(s.layout(80, 24 + (i % 2)))
    expect(reseeds).toEqual(['tail bound'])
    r.close()
  })

  it('runs one checkpoint at a time in the process', async () => {
    const s1 = stream()
    const s2 = stream()
    const a = replica().r
    const b = replica().r
    await a.event(s1.seed('\x1bc', 120, 40))
    await b.event(s2.seed('\x1bc', 120, 40))
    let most = 0
    let watching = true
    const watch = () => { most = Math.max(most, heavyWorkRunning()); if (watching) setImmediate(watch) }
    setImmediate(watch)
    const text = flood(CHECKPOINT_BYTES)
    await Promise.all([a.event(s1.output(text)), b.event(s2.output(text))])
    watching = false
    expect(a.stats.accepted + b.stats.accepted).toBe(2)
    expect(most).toBe(1)
    a.close()
    b.close()
  })

  it('ends on an invalid log and on close, and stops being joinable', async () => {
    const s = stream()
    const { r, ended } = replica()
    await r.event(s.seed('\x1bc', 40, 10))
    r.invalid('overflow')
    expect(ended()).toEqual(['log invalid: overflow'])
    expect(r.cut()).toBeUndefined()
    expect(r.terminal).toBeUndefined()
    await r.event(s.output('ignored'))
    r.pressure(MAX_BACKLOG_BYTES)
    r.close()
    expect(ended()).toEqual(['log invalid: overflow'])
  })
})

describe('Replica history after an overload', () => {
  it('an overload asks for screen-only seeds; quiet output brings the history back with one full seed', async () => {
    const s = stream()
    const { r, reseeds, scopes, diagnostics } = replica({ idleMs: 1e9, historyQuietMs: 40 })
    await r.event(s.seed('\x1bc', 40, 10))
    r.pressure(MAX_BACKLOG_BYTES)
    await until(() => reseeds.length === 1, 'the overload capture')
    expect([reseeds[0], scopes[0]]).toEqual(['overload', 'screen'])
    // The screen-only seed lands: joinable at once, history still owed.
    await r.event(s.seed('\x1bcscreen only', 40, 10, false))
    expect(r.cut()).toBeDefined()
    expect(diagnostics).toContainEqual({ kind: 'seeded', reason: 'test', history: false })
    // Output keeps coming (the log tells the replica of each event as it takes it): no restore while it does.
    for (let i = 0; i < 5; i++) { r.pressure(0); await r.event(s.output('more')); await Bun.sleep(15) }
    expect(reseeds).toHaveLength(1)
    // Quiet: one full seed is asked for, and the picture stays joinable meanwhile (not a rebuild).
    await until(() => reseeds.length === 2, 'the history restore')
    expect([reseeds[1], scopes[1]]).toEqual(['history', 'full'])
    expect(r.cut()).toBeDefined()
    await r.event(s.seed('\x1bcwith history', 40, 10, true))
    // Restored: nothing more is asked for.
    await Bun.sleep(100)
    expect(reseeds).toHaveLength(2)
    r.close()
  })
  it('a restore whose turn comes after output resumed is given up (no capture, no failure) and tried again', async () => {
    const s = stream()
    const captures: string[] = []
    let resumeOnce = true
    const r = new Replica({
      idleMs: 1e9, historyQuietMs: 30,
      reseed: async (reason, turn, scope) => {
        // Output arrives while the restore waits for its turn.
        if (reason === 'history' && resumeOnce) { resumeOnce = false; r.pressure(0) }
        try { await turn(async () => { captures.push(`${reason} ${scope}`) }) } catch (error) { if (!(error instanceof SeedDeferred)) throw error; throw error }
      },
    })
    await r.event(s.seed('\x1bc', 40, 10))
    r.pressure(MAX_BACKLOG_BYTES)
    await until(() => captures.length === 1, 'the overload capture')
    await r.event(s.seed('\x1bc', 40, 10, false))
    // The first restore is given up at its turn; once quiet again, the second captures.
    await until(() => captures.length === 2, 'the restore after quiet')
    expect(captures).toEqual(['overload screen', 'history full'])
    expect(r.ended).toBeUndefined()
    r.close()
  })
  it('while history is owed, a width rebuild seeds the screen alone too', async () => {
    const s = stream()
    const { r, reseeds, scopes } = replica({ idleMs: 1e9, historyQuietMs: 5_000 })
    await r.event(s.seed('\x1bc', 40, 10))
    r.pressure(MAX_BACKLOG_BYTES)
    await until(() => reseeds.length === 1, 'the overload capture')
    await r.event(s.seed('\x1bc', 40, 10, false))
    await r.event(s.layout(60, 10))
    await until(() => reseeds.length === 2, 'the width capture')
    expect(scopes).toEqual(['screen', 'screen'])
    r.close()
  })
  it('a quiet restore waits for a seed in flight and for the end of a rebuild', async () => {
    const s = stream()
    const { r, reseeds } = replica({ idleMs: 1e9, historyQuietMs: 30 })
    await r.event(s.seed('\x1bc', 40, 10))
    r.pressure(MAX_BACKLOG_BYTES)
    await until(() => reseeds.length === 1, 'the overload capture')
    // Still rebuilding (the screen seed has not landed): the restore waits.
    await Bun.sleep(80)
    expect(reseeds).toHaveLength(1)
    await r.event(s.seed('\x1bc', 40, 10, false))
    await until(() => reseeds.length === 2, 'the restore after the seed')
    r.close()
  })
})

describe('Replica subscription', () => {
  function listener() {
    const told: string[] = []
    const events: LogEvent[] = []
    return {
      told, events,
      handle: { event: (e: LogEvent) => { events.push(e); told.push(`event ${e.seq}`) }, rebuilding: (cause: string) => told.push(`rebuilding ${cause}`), rebased: () => told.push('rebased'), ended: (reason: string) => told.push(`ended ${reason}`) },
    }
  }
  it('starts seeding, is told of the seed, then of every committed event after its cut', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    const l = listener()
    const { state } = r.subscribe(l.handle)
    expect(state).toEqual({ kind: 'seeding' })
    await r.event(s.seed('\x1bc', 40, 10))
    expect(l.told).toEqual(['rebased'])
    const cut = r.cut()!
    expect(cut).toMatchObject({ baseSeq: 1, throughSeq: 1, tail: [] })
    await r.event(s.output('one'))
    await r.event(s.layout(40, 12))
    expect(l.told).toEqual(['rebased', 'event 2', 'event 3'])
    expect(r.cut()!.throughSeq).toBe(3)
    r.close()
  })
  it('leaves no gap and no duplicate between the cut and the events after it, joined mid-apply', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 40, 10))
    await r.event(s.output('before'))
    // An event still being parsed is not committed: the cut leaves it out, the listener is told of it.
    const taken = r.activity
    const inFlight = r.event(s.output('x'.repeat(200_000)))
    while (r.activity === taken) await Promise.resolve()
    const l = listener()
    const { state } = r.subscribe(l.handle)
    if (state.kind !== 'live') throw new Error('expected a live cut')
    const after = [r.event(s.output('after')), inFlight]
    await Promise.all(after)
    const seqs = [...state.cut.tail.map((e) => e.seq), ...l.events.map((e) => e.seq)]
    expect(seqs).toEqual([2, 3, 4])
    expect(state.cut.throughSeq).toBe(2)
    expect(l.events.every((e) => e.seq > state.cut.throughSeq)).toBe(true)
    r.close()
  })
  it('a subscription taken while a checkpoint runs misses nothing and repeats nothing', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 120, 40))
    const crossing = (async () => { await deliver(r, s, flood(CHECKPOINT_BYTES + BATCH_BYTES)) })()
    while (heavyWorkRunning() === 0) await new Promise((resolve) => setImmediate(resolve))
    const l = listener()
    const { state } = r.subscribe(l.handle)
    if (state.kind !== 'live') throw new Error('expected a live cut')
    await crossing
    await r.event(s.output('after the checkpoint'))
    await r.idle()
    expect(r.stats.accepted).toBe(1)
    const seqs = [...state.cut.tail.map((e) => e.seq), ...l.events.map((e) => e.seq)]
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 2))
    expect(seqs.at(-1)).toBe(r.cut()!.throughSeq)
    r.close()
  })
  it('a cut stays whole when a checkpoint replaces the tail', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 80, 24))
    await r.event(s.output('kept in the cut'))
    const cut = r.cut()!
    await deliver(r, s, flood(CHECKPOINT_BYTES + BATCH_BYTES))
    await r.idle()
    expect(r.stats.accepted).toBe(1)
    expect(r.cut()!.baseSeq).toBeGreaterThan(cut.baseSeq)
    expect(cut.tail.map((e) => e.seq)).toEqual([2])
    r.close()
  })
  it('never tells of an event a rebuild interrupted, and tells of the rebuild', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 40, 10))
    const l = listener()
    r.subscribe(l.handle)
    const taken = r.activity
    const interrupted = r.event(s.output('y'.repeat(200_000)))
    // Parsing has started (the replica took the event) when the rebuild comes.
    while (r.activity === taken) await Promise.resolve()
    r.pressure(MAX_BACKLOG_BYTES)
    await interrupted
    expect(l.told).toEqual(['rebuilding overload'])
    expect(r.state()).toEqual({ kind: 'rebuilding', cause: 'overload' })
    await r.event(s.output('skipped'))
    expect(l.events).toEqual([])
    r.close()
  })
  it('contains a throwing listener: the replica and the other listeners carry on', async () => {
    const s = stream()
    const { r, diagnostics } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 40, 10))
    r.subscribe({ event: () => { throw new Error('viewer broke') }, rebuilding: () => undefined, rebased: () => undefined, ended: () => undefined })
    const l = listener()
    r.subscribe(l.handle)
    await r.event(s.output('still parsed'))
    expect(l.told).toEqual(['event 2'])
    expect(diagnostics).toContainEqual({ kind: 'listener failed', error: 'viewer broke' })
    expect(r.cut()!.throughSeq).toBe(2)
    r.close()
  })
  it('tells of its end once, then forgets its listeners; unsubscribing stops the calls', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 40, 10))
    const kept = listener()
    const gone = listener()
    r.subscribe(kept.handle)
    r.subscribe(gone.handle).unsubscribe()
    await r.event(s.output('one'))
    r.close()
    r.close()
    expect(kept.told).toEqual(['event 2', 'ended closed'])
    expect(gone.told).toEqual([])
    expect(r.state()).toEqual({ kind: 'ended', reason: 'closed' })
  })
})

describe('Replica memory', () => {
  it('reports what it holds, sliced: the emulator, the base text and the tail', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    expect(drain(r.retainedSteps())).toBe(0)
    await r.event(s.seed('\x1bc' + 'seeded\r\n'.repeat(50), 40, 10))
    const seeded = drain(r.retainedSteps())
    expect(seeded).toBeGreaterThan(terminalBytes(r.terminal!))
    await r.event(s.output('x'.repeat(1000)))
    // The tail's bytes and its event.
    expect(drain(r.retainedSteps()) - seeded).toBeGreaterThanOrEqual(1000 + EVENT_OVERHEAD_BYTES)
    // Run sliced like the server's reading: the same total.
    expect(await runSliced(r.retainedSteps())).toBe(drain(r.retainedSteps()))
    r.close()
  })
  it('sweeps link orphans erased since the last sweep when maintained', async () => {
    const s = stream()
    const { r } = replica({ idleMs: 1e9 })
    await r.event(s.seed('\x1bc', 30, 12))
    let links = '\x1b[1"q'
    for (let i = 0; i < 300; i++) links += `\x1b]8;;https://x.example/${i}\x1b\\L\x1b]8;;\x1b\\`
    await r.event(s.output(links + '\x1b[0"q\x1b[?2J\x1b[2J'))
    const registry = () => (r.terminal as unknown as { _core: { _oscLinkService: { _dataByLinkId: Map<number, unknown> } } })._core._oscLinkService._dataByLinkId.size
    expect(registry()).toBe(300)
    await r.maintain()
    expect(registry()).toBe(0)
    r.close()
  })
})

describe('runSliced', () => {
  it('closes abandoned steps, before the first step too', async () => {
    let closed = 0
    let ran = 0
    function* steps(): Generator<void, string> {
      try { for (;;) { ran++; yield } } finally { closed++ }
    }
    expect(await runSliced(steps(), () => true)).toBeUndefined()
    expect(ran).toBe(0)
    let calls = 0
    expect(await runSliced(steps(), () => ++calls > 2, 0)).toBeUndefined()
    expect(closed).toBe(1)
    function* done(): Generator<void, string> { yield; return 'ok' }
    expect(await runSliced(done())).toBe('ok')
  })
})
