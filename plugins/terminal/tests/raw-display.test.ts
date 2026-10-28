import { describe, expect, it } from 'bun:test'
import type { Checkpoint } from '../lib/checkpoint'
import type { LogEvent } from '../lib/output-log'
import { checkpointBytes, checkpointText, displayBytes, JOIN_WAIT_MS, RawDisplay, RESYNC_INTERVAL_MS, VIEWER_QUEUE_BYTES, type RawSource } from '../lib/raw-display'
import type { Cut, ReplicaListener, ReplicaState } from '../lib/replica'

const encode = (text: string) => new TextEncoder().encode(text)

function checkpoint(data: string[]): Checkpoint {
  return { format: 1, cols: 80, rows: 24, scrollback: 10_000, data, joinState: 0, penHasExtended: false, altEnteredCols: null } as Checkpoint
}
function cut(data: string[], baseSeq: number, tail: LogEvent[] = []): Cut {
  return { checkpoint: checkpoint(data), baseSeq, tail, throughSeq: tail.at(-1)?.seq ?? baseSeq }
}
const output = (seq: number, text: string | Uint8Array): LogEvent => ({ seq, kind: 'output', offset: 0, bytes: typeof text === 'string' ? encode(text) : text })

/** A replica stand-in: a state, and the listener it tells. */
function fakeSource(initial: ReplicaState) {
  let state = initial
  let listener: ReplicaListener | undefined
  const source: RawSource = {
    subscribe: (next) => { listener = next; return { state, unsubscribe: () => { listener = undefined } } },
    state: () => state,
  }
  return {
    source,
    set: (next: ReplicaState) => { state = next },
    tell: () => listener!,
    get subscribed() { return listener !== undefined },
  }
}

type Sent = { json: Record<string, unknown> } | { bytes: Uint8Array }
function harness(initial: ReplicaState, options: { window?: number; pauseEvictMs?: number; header?: () => Record<string, unknown> | undefined } = {}) {
  let now = 0
  const sent: Sent[] = []
  const resyncs: string[] = []
  const src = fakeSource(initial)
  let open = true
  const display = new RawDisplay(src.source, {
    text: (json) => { if (open) sent.push({ json: JSON.parse(json) }); return open },
    binary: (bytes) => { if (open) sent.push({ bytes }); return open },
  }, {
    header: options.header ?? (() => ({ session: { id: 's1' } })),
    fidelity: () => ({ rebuilds: {} }),
    resync: (reason) => { resyncs.push(reason); open = false },
    deadline: JOIN_WAIT_MS,
    window: options.window ?? 1024 * 1024,
    pauseEvictMs: options.pauseEvictMs ?? 10_000,
    now: () => now,
  })
  const kinds = () => sent.map((frame) => 'json' in frame ? String(frame.json.type) : `bytes ${frame.bytes.length}`)
  /** Bytes the display has counted as sent: every frame (JSON by its UTF-8 length). */
  const total = () => sent.reduce((sum, frame) => sum + ('json' in frame ? Buffer.byteLength(JSON.stringify(frame.json)) : frame.bytes.length), 0)
  return { display, sent, resyncs, src, kinds, total, advance: (ms: number) => { now += ms } }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('checkpoint text', () => {
  it('is the exact UTF-8 of the joined data, never splitting a surrogate pair, even one split across data strings', () => {
    const big = 'a'.repeat(16 * 1024 - 1) + '👍' + 'b'.repeat(10)
    for (const data of [['plain'], ['é😀', 'x'], [big], ['abc\ud83d', '\udc4dxyz'], ['\ud83d', '\udc4d']]) {
      const chunks = [...checkpointText(data)]
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length }
      expect(joined).toEqual(encode(data.join('')))
      expect(checkpointBytes(data)).toBe(encode(data.join('')).length)
      // No chunk ends inside a character: each decodes alone without a replacement.
      for (const chunk of chunks) expect(new TextDecoder('utf-8', { fatal: true }).decode(chunk)).toBeTruthy()
    }
  })
})

describe('RawDisplay join', () => {
  it('sends the header, the checkpoint text, the tail, the barrier, then live events', () => {
    const h = harness({ kind: 'live', cut: cut(['\x1bcHello'], 4, [output(5, 'tail'), { seq: 6, kind: 'layout', cols: 90, rows: 24 }]) })
    h.display.start()
    expect(h.kinds()).toEqual(['join', 'bytes 7', 'bytes 4', 'layout', 'barrier'])
    expect(h.sent[0]).toMatchObject({ json: { type: 'join', epoch: 1, bytes: 7, baseSeq: 4, throughSeq: 6, session: { id: 's1' }, checkpoint: { cols: 80, rows: 24 } } })
    expect(h.sent[4]).toEqual({ json: { type: 'barrier', epoch: 1, throughSeq: 6 } })
    h.src.tell().event(output(7, 'live'))
    expect(h.kinds().at(-1)).toBe('bytes 4')
  })
  it('waits for a seed (absolute from the join), then joins; past the wait it resyncs', async () => {
    const h = harness({ kind: 'seeding' })
    h.display.start()
    expect(h.sent).toEqual([])
    h.src.tell().event(output(2, 'ignored'))
    h.src.set({ kind: 'live', cut: cut(['seed'], 3) })
    h.src.tell().rebased()
    expect(h.kinds()).toEqual(['join', 'bytes 4', 'barrier'])
    const late = harness({ kind: 'rebuilding', cause: 'overload' })
    late.advance(0)
    const realTimeout = globalThis.setTimeout
    let fired: (() => void) | undefined
    globalThis.setTimeout = ((fn: () => void, ms: number) => { if (ms === JOIN_WAIT_MS) fired = fn; return realTimeout(() => undefined, 0) }) as typeof setTimeout
    try { late.display.start() } finally { globalThis.setTimeout = realTimeout }
    // A rebuild notice meanwhile does not extend the wait.
    late.src.tell().rebuilding('overload')
    fired!()
    expect(late.resyncs).toEqual(['Terminal output not ready; reconnect'])
    await tick()
  })
  it('resyncs at once when the replica has ended', () => {
    const h = harness({ kind: 'ended', reason: 'closed' })
    h.display.start()
    expect(h.resyncs).toHaveLength(1)
  })
})

describe('RawDisplay credit', () => {
  it('sends within the window, counts every frame, and a rebase never resets the credit', () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(40_000)], 1) }, { window: 20_000 })
    h.display.start()
    // The header and one text frame of 16K: the window is full (overshoot by one frame at most).
    expect(h.kinds()).toEqual(['join', 'bytes 16384', 'bytes 16384'])
    const sentSoFar = h.total()
    h.display.retire(sentSoFar)
    expect(h.kinds().slice(3)).toEqual(['bytes 7232', 'barrier'])
    // A rebase: the connection's count goes on; nothing is granted for discarded frames until retired.
    h.src.set({ kind: 'live', cut: cut(['y'.repeat(30_000)], 9) })
    h.advance(RESYNC_INTERVAL_MS)
    h.src.tell().rebuilding('overload')
    h.src.tell().rebased()
    expect(h.kinds().slice(5)).toEqual(['rebuilding', 'rebase', 'bytes 16384'])
  })
  it('arms the stall eviction while the window is full; progress that stays above the window keeps its original deadline', async () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(40_000)], 1) }, { window: 20_000, pauseEvictMs: 80 })
    const started = Date.now()
    h.display.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    // Some progress halfway, still at least a window outstanding: the deadline is not restarted.
    h.display.retire(100)
    for (let i = 0; i < 100 && !h.resyncs.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.resyncs).toEqual(['Viewer fell behind; resync'])
    // A restarted timer would have fired at about 120 ms.
    expect(Date.now() - started).toBeLessThan(110)
  })
  it('progress below the window clears the eviction; a later fill arms it again; a rebase keeps its age', async () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(40_000)], 1) }, { window: 20_000, pauseEvictMs: 40 })
    h.display.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.display.retire(h.total())
    // Cleared: past the first deadline, no eviction.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.resyncs).toEqual([])
    // Full again (the rest of the text, then live output), then a rebase while full: the deadline is not reset.
    const chunk = new Uint8Array(64 * 1024)
    h.src.tell().event(output(2, chunk))
    h.src.set({ kind: 'live', cut: cut(['y'], 3) })
    h.advance(RESYNC_INTERVAL_MS)
    h.src.tell().rebuilding('overload')
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.src.tell().rebased()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.resyncs).toEqual(['Viewer fell behind; resync'])
  })
  it('retirement is capped at what was sent and never goes back', () => {
    const h = harness({ kind: 'live', cut: cut([''], 1) }, { window: 10_000 })
    h.display.start()
    const chunk = new Uint8Array(4_000)
    let seq = 2
    // Over-retire: credit is still what was really outstanding, so only a window more goes.
    h.display.retire(10 * h.total())
    const capped = h.total()
    for (let i = 0; i < 10; i++) h.src.tell().event(output(seq++, chunk))
    expect(h.total() - capped).toBeLessThanOrEqual(10_000 + 4_000)
    expect(h.total() - capped).toBeGreaterThanOrEqual(10_000)
    // Everything sent and retired, then a smaller total: credit stays (a total never goes back), so the next event goes at once.
    for (let last = -1; last !== h.total();) { last = h.total(); h.display.retire(last) }
    const settled = h.total()
    h.display.retire(5)
    h.src.tell().event(output(seq, chunk))
    expect(h.total() - settled).toBe(4_000)
  })
  it('counts a JSON frame by its UTF-8 bytes', () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(40_000)], 1) }, { window: 20_000, header: () => ({ session: { title: 'é'.repeat(3000) } }) })
    h.display.start()
    // The header alone is over 6,000 bytes (3,000 characters): one text frame more fills the window.
    expect(Buffer.byteLength(JSON.stringify(h.sent[0]!.json))).toBeGreaterThan(6000)
    expect(h.kinds()).toEqual(['join', 'bytes 16384'])
  })
  it('counts layout frames too: a stream of zero-output layouts is bounded by the window', () => {
    const h = harness({ kind: 'live', cut: cut([''], 1) }, { window: 300 })
    h.display.start()
    const before = h.sent.length
    for (let seq = 2; seq < 200; seq++) h.src.tell().event({ seq, kind: 'layout', cols: 80, rows: seq % 50 + 1 })
    expect(h.sent.length - before).toBeLessThan(10)
  })
})

describe('RawDisplay replacement', () => {
  it('a backlog overflow while live is replaced by the latest cut, at most once a second', () => {
    const h = harness({ kind: 'live', cut: cut(['base'], 1) }, { window: 64 })
    h.display.start()
    h.display.retire(h.total())
    // The window holds output back; the backlog fills past its bound.
    const chunk = new Uint8Array(64 * 1024)
    let seq = 2
    while (seq * 64 * 1024 <= VIEWER_QUEUE_BYTES + 4 * 64 * 1024) h.src.tell().event(output(seq++, chunk))
    h.src.set({ kind: 'live', cut: cut(['latest'], seq) })
    h.display.retire(h.total())
    // Throttled: the first join was just now.
    expect(h.kinds().filter((kind) => kind === 'rebase')).toEqual([])
    h.advance(RESYNC_INTERVAL_MS)
    return new Promise<void>((resolve) => setTimeout(() => {
      h.display.retire(h.total())
      expect(h.sent.find((frame) => 'json' in frame && frame.json.type === 'rebase')).toMatchObject({ json: { baseSeq: seq, epoch: 2 } })
      resolve()
    }, RESYNC_INTERVAL_MS + 20))
  })
  it('never cancels a replay in progress: overflow and rebuilds during it are one replacement after its barrier', async () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(100_000)], 1) }, { window: 20_000 })
    h.display.start()
    expect(h.kinds()[0]).toBe('join')
    const chunk = new Uint8Array(64 * 1024)
    for (let seq = 2; seq < 50; seq++) h.src.tell().event(output(seq, chunk))
    h.src.tell().rebuilding('overload')
    h.src.set({ kind: 'live', cut: cut(['newer'], 60) })
    h.src.tell().rebased()
    h.src.tell().rebuilding('tail bound')
    h.src.set({ kind: 'live', cut: cut(['newest'], 70) })
    h.src.tell().rebased()
    h.advance(RESYNC_INTERVAL_MS)
    // The first replay runs to its barrier while ACKs continue: every byte of its text, then its barrier.
    for (let i = 0; i < 20 && !h.kinds().includes('barrier'); i++) h.display.retire(h.total())
    const barrier = h.kinds().indexOf('barrier')
    const text = h.sent.slice(1, barrier).reduce((n, frame) => n + ('bytes' in frame ? frame.bytes.length : 0), 0)
    expect(text).toBe(100_000)
    expect(h.sent[barrier]).toEqual({ json: { type: 'barrier', epoch: 1, throughSeq: 1 } })
    h.display.replayApplied(1)
    expect(h.display.latched).toBe(true)
    await tick()
    h.display.retire(h.total())
    const headers = h.sent.flatMap((frame) => 'json' in frame && (frame.json.type === 'join' || frame.json.type === 'rebase') ? [frame.json] : [])
    expect(headers.map((json) => [json.type, json.epoch, json.baseSeq])).toEqual([['join', 1, 1], ['rebase', 2, 70]])
    expect(h.sent.filter((frame) => 'json' in frame && frame.json.type === 'barrier').map((frame) => 'json' in frame && frame.json.epoch)).toEqual([1, 2])
  })
  it('a rebuilding notice goes out with the picture it is about, never after its replacement', () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(40_000)], 1) }, { window: 20_000 })
    h.display.start()
    h.src.tell().rebuilding('overload')
    h.src.set({ kind: 'live', cut: cut(['new'], 9) })
    h.src.tell().rebased()
    h.advance(RESYNC_INTERVAL_MS)
    for (let i = 0; i < 10; i++) h.display.retire(h.total())
    return new Promise<void>((resolve) => setTimeout(() => {
      for (let i = 0; i < 10; i++) h.display.retire(h.total())
      // The notice follows the first picture's barrier; the rebase follows it, and nothing stale after that.
      expect(h.kinds().filter((kind) => !kind.startsWith('bytes'))).toEqual(['join', 'barrier', 'rebuilding', 'rebase', 'barrier'])
      resolve()
    }, 5))
  })
  it('a picture whose header cannot be made sends nothing', () => {
    const h = harness({ kind: 'live', cut: cut(['secret'], 1) }, { header: () => undefined })
    h.display.start()
    expect(h.sent).toEqual([])
  })
  it('a stale barrier callback starts no replacement nobody owes, even past the throttle', async () => {
    const h = harness({ kind: 'live', cut: cut(['x'.repeat(40_000)], 1) }, { window: 20_000 })
    h.display.start()
    h.advance(RESYNC_INTERVAL_MS)
    // A replacement owed during replay 1.
    h.src.set({ kind: 'live', cut: cut(['b'], 4) })
    h.src.tell().rebuilding('overload')
    h.src.tell().rebased()
    // In one turn: replay 1 finishes (its barrier queues a callback), a later seed starts
    // replay 2 at once and it finishes too, all before replay 1's callback runs.
    h.display.retire(h.total())
    h.display.retire(h.total())
    h.src.set({ kind: 'live', cut: cut(['c'], 6) })
    h.src.tell().rebuilding('overload')
    h.advance(RESYNC_INTERVAL_MS)
    h.src.tell().rebased()
    h.display.retire(h.total())
    h.display.retire(h.total())
    // Past the throttle: a stale callback would start another rebase at once.
    h.advance(RESYNC_INTERVAL_MS)
    await tick()
    await tick()
    h.display.retire(h.total())
    const headers = h.sent.flatMap((frame) => 'json' in frame && (frame.json.type === 'join' || frame.json.type === 'rebase') ? [[frame.json.type, frame.json.baseSeq]] : [])
    expect(headers).toEqual([['join', 1], ['rebase', 6]])
  })
  it('a partly sent live event stops at a replacement; nothing of it follows the new header', () => {
    const h = harness({ kind: 'live', cut: cut(['a'], 1) }, { window: 70 * 1024 })
    h.display.start()
    h.display.retire(h.total())
    h.src.tell().event(output(2, new Uint8Array(200 * 1024)))
    // One or two of its frames are out; then a replacement.
    h.src.set({ kind: 'live', cut: cut(['b'], 3) })
    h.advance(RESYNC_INTERVAL_MS)
    h.src.tell().rebuilding('overload')
    h.src.tell().rebased()
    for (let i = 0; i < 10; i++) h.display.retire(h.total())
    const kinds = h.kinds()
    const rebase = kinds.indexOf('rebase')
    expect(rebase).toBeGreaterThan(0)
    expect(kinds.slice(rebase)).toEqual(['rebase', 'bytes 1', 'barrier'])
  })
  it('lets the viewer type once any replay it was sent is applied, an applied one crossing a replacement included', () => {
    const h = harness({ kind: 'live', cut: cut(['a'], 1) })
    h.display.start()
    expect(h.display.latched).toBe(false)
    h.display.replayApplied(7)
    expect(h.display.latched).toBe(false)
    h.src.set({ kind: 'live', cut: cut(['b'], 5) })
    h.advance(RESYNC_INTERVAL_MS)
    h.src.tell().rebuilding('overload')
    h.src.tell().rebased()
    // The client applied epoch 1's barrier before epoch 2's header reached it.
    h.display.replayApplied(1)
    expect(h.display.latched).toBe(true)
  })
  it('counts what it holds beyond the replica: the backlog and bytes in flight', () => {
    const h = harness({ kind: 'live', cut: cut(['base'], 1) }, { window: 1 })
    h.display.start()
    h.src.tell().event(output(2, 'x'.repeat(1000)))
    expect(displayBytes(h.display)).toBeGreaterThanOrEqual(1000 + h.total())
  })
  it('counts a pinned cut whose barrier went out while its generator waits for credit, once the replica moved on', () => {
    const megabyte = 'x'.repeat(1024 * 1024)
    // How many bytes the replay is, through its barrier.
    const dry = harness({ kind: 'live', cut: cut([megabyte], 1) }, { window: 1e9 })
    dry.display.start()
    const through = dry.total()
    // The window fills exactly with the barrier: the generator stays suspended after it.
    const h = harness({ kind: 'live', cut: cut([megabyte], 1) }, { window: through - 1 })
    h.display.start()
    expect(h.kinds().at(-1)).toBe('barrier')
    h.src.set({ kind: 'live', cut: cut(['other'], 5) })
    // The checkpoint text is held apart from what is in flight (nothing is retired yet: all of it is outstanding).
    expect(displayBytes(h.display) - h.total()).toBeGreaterThanOrEqual(1024 * 1024)
    // Once the generator finishes, the cut is let go.
    h.display.retire(h.total())
    expect(displayBytes(h.display)).toBeLessThan(1024)
  })
})
