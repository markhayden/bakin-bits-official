import { describe, expect, it } from 'bun:test'
import { restoreCheckpoint } from '../lib/checkpoint'
import { BATCH_BYTES, type LogEvent } from '../lib/output-log'
import {
  CHECKPOINT_BYTES, heavyWorkRunning, MAX_BACKLOG_BYTES, MAX_TAIL_BYTES, MAX_TAIL_EVENTS, REBUILD_INTERVAL_MS, REBUILD_QUIET_MS, Replica,
  type JoinPoint, type ReplicaDiagnostic, runSliced,
} from '../lib/replica'
import { fullState, stateDiff, type Term } from '../lib/terminal-state'
import { emulator, settled } from './helpers/terminal-fuzz'

const encode = (text: string) => new TextEncoder().encode(text)

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
    seed: (text: string, cols: number, rows: number): LogEvent => ({ seq: ++seq, kind: 'seed', bytes: encode(text), cols, rows, reason: 'test' }),
  }
}

function replica(options: Partial<ConstructorParameters<typeof Replica>[0]> = {}) {
  const reseeds: string[] = []
  const diagnostics: ReplicaDiagnostic[] = []
  // Captures take their turn in the heavy-work queue, as lib/reseed.ts does.
  const r = new Replica({ reseed: (reason, turn) => turn(async () => { reseeds.push(reason) }), diagnostic: (event) => diagnostics.push(event), ...options })
  const ended = () => diagnostics.flatMap((event) => event.kind === 'ended' ? [event.reason] : [])
  return { r, reseeds, diagnostics, ended }
}

/** A viewer's join: the base restored, then the tail. */
async function join(point: JoinPoint): Promise<Term> {
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
async function expectJoinable(r: Replica): Promise<JoinPoint> {
  const point = r.joinPoint()
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
    expect(r.joinPoint()).toBeUndefined()
    await r.event(s.seed('\x1bc\x1b[1mseeded\x1b[0m\r\n$ ', 40, 10))
    await r.event(s.output('typed'))
    const point = await expectJoinable(r)
    expect(point.seq).toBe(2)
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
    expect(r.joinPoint()!.tail.length).toBe(1)
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
    expect(r.joinPoint()).toBeUndefined()
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
    expect(r.joinPoint()).toBeUndefined()
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
    expect(r.joinPoint()).toBeUndefined()
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
    expect(point.seq).toBe(seed.seq)
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

  it('a seed too large for one step is parsed in pieces, and overload stops it', async () => {
    const s = stream()
    const { r, reseeds } = replica()
    await r.event(s.seed('\x1bc', 80, 24))
    const big = s.seed('\x1bc' + flood(2 * 1024 * 1024), 80, 24)
    const pending = r.event(big)
    await Bun.sleep(5)
    r.pressure(MAX_BACKLOG_BYTES)
    await pending
    expect(r.joinPoint()).toBeUndefined()
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
    expect(r.joinPoint()!.tail).toEqual([])
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
    expect(r.joinPoint()).toBeUndefined()
    expect(r.terminal).toBeUndefined()
    await r.event(s.output('ignored'))
    r.pressure(MAX_BACKLOG_BYTES)
    r.close()
    expect(ended()).toEqual(['log invalid: overflow'])
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
