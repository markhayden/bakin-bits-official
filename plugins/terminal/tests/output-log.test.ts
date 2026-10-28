import { describe, expect, it } from 'bun:test'
import { BATCH_BYTES, BATCH_MS, MAX_QUEUED_BYTES, MAX_QUEUED_EVENTS, OutputLog, parseLayoutChange, type LogEvent } from '../lib/output-log'

function consumer(slow?: () => Promise<void>) {
  const events: LogEvent[] = []
  const invalid: string[] = []
  return {
    events, invalid,
    consumer: { event: async (event: LogEvent) => { events.push(event); await slow?.() }, invalid: (reason: string) => invalid.push(reason) },
  }
}
const text = (event: LogEvent) => event.kind === 'output' ? new TextDecoder().decode(event.bytes) : `<${event.cols}x${event.rows}>`

describe('OutputLog', () => {
  it('batches output for a short time, then delivers it in order with byte offsets', async () => {
    const log = new OutputLog()
    const { events, consumer: c } = consumer()
    log.attach(c)
    log.output(new TextEncoder().encode('ab'))
    log.output(new TextEncoder().encode('c'))
    expect(events).toEqual([])
    await Bun.sleep(BATCH_MS + 10)
    log.output(new TextEncoder().encode('de'))
    log.flush()
    await Bun.sleep(0)
    expect(events.map(text)).toEqual(['abc', 'de'])
    expect(events.map((event) => event.kind === 'output' && event.offset)).toEqual([0, 3])
    expect(events.map((event) => event.seq)).toEqual([1, 2])
  })
  it('cuts batches at BATCH_BYTES, anywhere', async () => {
    const log = new OutputLog()
    const { events, consumer: c } = consumer()
    log.attach(c)
    log.output(new Uint8Array(BATCH_BYTES * 2 + 5).fill(0x41))
    log.flush()
    await Bun.sleep(0)
    expect(events.map((event) => event.kind === 'output' && event.bytes.length)).toEqual([BATCH_BYTES, BATCH_BYTES, 5])
  })
  it('a layout change is ordered after every output byte before it', async () => {
    const log = new OutputLog()
    const { events, consumer: c } = consumer()
    log.attach(c)
    log.output(new TextEncoder().encode('before'))
    log.layout(100, 30)
    log.output(new TextEncoder().encode('after'))
    log.flush()
    await Bun.sleep(0)
    expect(events.map(text)).toEqual(['before', '<100x30>', 'after'])
  })
  it('keeps nothing without a consumer', async () => {
    const log = new OutputLog()
    log.output(new Uint8Array(MAX_QUEUED_BYTES * 2))
    log.flush()
    expect(log.pendingBytes).toBe(0)
    expect(log.invalidReason).toBeUndefined()
  })
  it('a consumer that falls more than MAX_QUEUED_BYTES behind invalidates the log, once', async () => {
    const log = new OutputLog()
    let release!: () => void
    const stalled = new Promise<void>((resolve) => { release = resolve })
    const { events, invalid, consumer: c } = consumer(() => stalled)
    log.attach(c)
    for (let i = 0; i <= MAX_QUEUED_BYTES / BATCH_BYTES + 1; i++) { log.output(new Uint8Array(BATCH_BYTES)); log.flush() }
    expect(invalid).toEqual(['overflow'])
    expect(log.invalidReason).toBe('overflow')
    release()
    await Bun.sleep(0)
    const delivered = events.length
    log.output(new Uint8Array(10))
    log.layout(80, 24)
    log.flush()
    await Bun.sleep(0)
    expect(events.length).toBe(delivered)
    expect(log.pendingBytes).toBe(0)
  })
  it('a source failure invalidates with its reason; a consumer attached later learns it at once', () => {
    const log = new OutputLog()
    log.invalidate('too far behind')
    log.invalidate('eof')
    const { invalid, consumer: c } = consumer()
    log.attach(c)
    expect(invalid).toEqual(['too far behind'])
  })
  it('a consumer that throws invalidates the log', async () => {
    const log = new OutputLog()
    const invalid: string[] = []
    log.attach({ event: () => { throw new Error('parser failed') }, invalid: (reason) => invalid.push(reason) })
    log.output(new Uint8Array(1))
    log.flush()
    await Bun.sleep(0)
    expect(invalid).toEqual(['consumer failed: parser failed'])
  })
  it('has one consumer; a detached consumer stops receiving and leaves no accounting behind', async () => {
    const log = new OutputLog()
    const { events, consumer: c } = consumer()
    const detach = log.attach(c)
    expect(() => log.attach(consumer().consumer)).toThrow('already has a consumer')
    detach()
    log.output(new Uint8Array(3))
    log.flush()
    await Bun.sleep(0)
    expect(events).toEqual([])
    expect(log.pendingBytes).toBe(0)
  })
})

describe('OutputLog consumers', () => {
  it('output before a consumer attaches, or not yet delivered when it detaches, never reaches the next one', async () => {
    const log = new OutputLog()
    log.output(new TextEncoder().encode('old'))
    const first = consumer()
    const detach = log.attach(first.consumer)
    log.output(new TextEncoder().encode('mine'))
    detach()
    const second = consumer()
    log.attach(second.consumer)
    log.output(new TextEncoder().encode('new'))
    log.flush()
    await Bun.sleep(0)
    expect(first.events.map(text)).toEqual([])
    expect(second.events.map(text)).toEqual(['new'])
  })
  it('a detached consumer whose event never settles does not stall its replacement', async () => {
    const log = new OutputLog()
    const detach = log.attach({ event: () => new Promise(() => {}), invalid: () => {} })
    log.output(new Uint8Array(1))
    log.flush()
    await Bun.sleep(0)
    detach()
    const next = consumer()
    log.attach(next.consumer)
    log.output(new TextEncoder().encode('x'))
    log.flush()
    await Bun.sleep(0)
    expect(next.events.map(text)).toEqual(['x'])
  })
  it('a detached consumer that fails later does not invalidate its replacement\'s log', async () => {
    const log = new OutputLog()
    let fail!: (error: Error) => void
    const detach = log.attach({ event: () => new Promise((_, reject) => { fail = reject }), invalid: () => {} })
    log.output(new Uint8Array(1))
    log.flush()
    await Bun.sleep(0)
    detach()
    const next = consumer()
    log.attach(next.consumer)
    fail(new Error('late'))
    await Bun.sleep(0)
    expect(log.invalidReason).toBeUndefined()
    expect(next.invalid).toEqual([])
  })
  it('layout events count against the bound too', () => {
    const log = new OutputLog()
    const stalled = consumer(() => new Promise(() => {}))
    log.attach(stalled.consumer)
    for (let i = 0; i <= MAX_QUEUED_EVENTS + 1; i++) log.layout(80 + (i % 2), 24)
    expect(stalled.invalid).toEqual(['overflow'])
  })
})

describe('parseLayoutChange', () => {
  it('reads the window size from a %layout-change line', () => {
    expect(parseLayoutChange('%layout-change @1 b25e,120x40,0,0,0 b25e,120x40,0,0,0 *')).toEqual({ window: '@1', cols: 120, rows: 40 })
    expect(parseLayoutChange('%layout-change @12 a1b2,80x24,0,0{40x24,0,0,1,39x24,41,0,2} a1b2,80x24,0,0 *')).toEqual({ window: '@12', cols: 80, rows: 24 })
    expect(parseLayoutChange('%window-renamed @1 bash')).toBeUndefined()
  })
})
