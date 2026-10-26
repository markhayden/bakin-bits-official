import { describe, expect, it } from 'bun:test'
import { TerminalSocketClient, type SocketLike } from '../components/terminal-socket'
import type { Session } from '../lib/contracts'

const session = { id: 's1', generation: 1, inputSequence: 0, cols: 100, rows: 30, state: 'running' } as Session

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  readonly sent: Array<Record<string, unknown>> = []
  binaryType = 'blob'
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.() }
  server(payload: Record<string, unknown> | Uint8Array) {
    this.onmessage?.({ data: payload instanceof Uint8Array ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : JSON.stringify(payload) })
  }
  of(type: string) { return this.sent.filter((frame) => frame.type === type) }
}

function setup(overrides: Partial<ConstructorParameters<typeof TerminalSocketClient>[0]> = {}) {
  FakeSocket.all = []
  const events = { syncs: [] as unknown[], output: [] as Uint8Array[], sessions: [] as Session[], results: [] as unknown[], statuses: [] as string[] }
  const client = new TerminalSocketClient({
    url: 'ws://host/api/plugins/terminal/socket?id=s1', clientId: 'tab-0123456789abcdef',
    createSocket: (url) => new FakeSocket(url),
    onSync: (sync) => { events.syncs.push(sync) },
    onOutput: (bytes, done) => { events.output.push(bytes); done() },
    onSession: (next) => { events.sessions.push(next) },
    onResult: (result) => { events.results.push(result) },
    onStatus: (status) => { events.statuses.push(status) },
    ackBytes: 10, ackMs: 1000, coalesceMs: 5, reconnectMs: [5, 10],
    ...overrides,
  })
  return { client, events, socket: () => FakeSocket.all.at(-1)! }
}

async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await Bun.sleep(2) }
  throw new Error(`timed out: ${label}`)
}

describe('TerminalSocketClient', () => {
  it('says hello on open and accepts input only after sync', () => {
    const { client, socket } = setup()
    client.connect()
    socket().open()
    expect(socket().sent[0]).toEqual({ type: 'hello', clientId: 'tab-0123456789abcdef' })
    expect(client.input(1, 'early')).toBe(false)
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    expect(client.input(1, 'ls')).toBe(true)
    expect(socket().of('input')).toEqual([{ type: 'input', generation: 1, viewerSeq: 1, data: 'ls' }])
  })

  it('acknowledges output only after it is written, in batches', () => {
    let finish: (() => void) | undefined
    const { client, socket } = setup({ onOutput: (_bytes, done) => { finish = done } })
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    socket().server(new Uint8Array(12))
    expect(socket().of('ack')).toEqual([])
    finish!()
    expect(socket().of('ack')).toEqual([{ type: 'ack', epoch: 1, bytes: 12 }])
  })

  it('coalesces keystrokes while an envelope is in flight, never across a generation change', async () => {
    const { client, socket } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    client.input(1, 'a')
    client.input(1, 'b')
    client.input(1, 'c')
    expect(socket().of('input').map((frame) => frame.data)).toEqual(['a'])
    // A generation change flushes the old batch instead of merging into it.
    client.input(2, 'd')
    expect(socket().of('input').map((frame) => frame.data)).toEqual(['a', 'bc'])
    socket().server({ type: 'result', viewerSeq: 1, status: 'accepted' })
    await until(() => socket().of('input').length === 3, 'batches flush in order')
    expect(socket().of('input').map((frame) => [frame.generation, frame.viewerSeq, frame.data])).toEqual([[1, 1, 'a'], [1, 2, 'bc'], [2, 3, 'd']])
  })

  it('reports rejected and uncertain results and drops queued input after a rejection', async () => {
    const { client, socket, events } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    client.input(1, 'a')
    client.input(1, 'queued')
    socket().server({ type: 'result', viewerSeq: 1, status: 'rejected', error: 'Input ownership changed' })
    await Bun.sleep(15)
    expect(socket().of('input').map((frame) => frame.data)).toEqual(['a'])
    expect(events.results).toEqual([{ viewerSeq: 1, status: 'rejected', error: 'Input ownership changed' }])
    client.input(1, 'again')
    socket().server({ type: 'result', viewerSeq: 2, status: 'uncertain', error: 'may have been delivered' })
    expect(events.results.at(-1)).toEqual({ viewerSeq: 2, status: 'uncertain', error: 'may have been delivered' })
  })

  it('reconnects after a drop, resyncs, never replays input, and starts sequences over', async () => {
    const { client, socket, events } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    client.input(1, 'sent once')
    const first = socket()
    first.close(1006)
    expect(client.input(1, 'while down')).toBe(false)
    await until(() => FakeSocket.all.length === 2, 'reconnect')
    socket().open()
    expect(socket().sent).toEqual([{ type: 'hello', clientId: 'tab-0123456789abcdef' }])
    socket().server({ type: 'sync', epoch: 2, session, snapshot: '', cursor: 0 })
    client.input(1, 'next')
    expect(socket().of('input')).toEqual([{ type: 'input', generation: 1, viewerSeq: 1, data: 'next' }])
    expect(events.statuses).toContain('Reconnecting')
  })

  it('reconnects at once when asked (page visible again) and stops for a superseded socket', async () => {
    const { client, socket, events } = setup({ reconnectMs: [60_000] })
    client.connect(); socket().open()
    socket().close(1006)
    client.resume()
    expect(FakeSocket.all).toHaveLength(2)
    socket().open()
    socket().close(4001)
    await Bun.sleep(20)
    expect(FakeSocket.all).toHaveLength(2)
    expect(events.statuses.at(-1)).toBe('Opened in another tab')
  })

  it('answers pings and pushes session updates', () => {
    const { client, socket, events } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'ping' })
    expect(socket().of('pong')).toHaveLength(1)
    socket().server({ type: 'session', session: { ...session, generation: 2 } })
    expect(events.sessions.at(-1)?.generation).toBe(2)
  })

  it('tags acknowledgements with the sync epoch and ignores writes finished for an older one', () => {
    const finishes: Array<() => void> = []
    const { client, socket } = setup({ onOutput: (_bytes, done) => { finishes.push(done) } })
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    socket().server(new Uint8Array(12))
    socket().server({ type: 'sync', epoch: 2, session, snapshot: '', cursor: 0 })
    finishes[0]!()
    expect(socket().of('ack')).toEqual([])
    socket().server(new Uint8Array(12))
    finishes[1]!()
    expect(socket().of('ack')).toEqual([{ type: 'ack', epoch: 2, bytes: 12 }])
  })

  it('reports in-flight input as uncertain and unsent input as not sent when the connection drops', () => {
    const { client, socket, events } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    client.input(1, 'sent')
    client.input(1, 'queued')
    socket().close(1006)
    // One outcome, and it keeps the uncertainty visible.
    expect(events.results).toEqual([
      { viewerSeq: 1, status: 'uncertain', error: 'The connection dropped before your input was confirmed; anything typed after it was not sent' },
    ])
  })

  it('after a confirmed input, a drop with new input in flight and queued still reports uncertainty', () => {
    const { client, socket, events } = setup({ coalesceMs: 60_000 })
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    client.input(1, 'a')
    socket().server({ type: 'result', viewerSeq: 1, status: 'accepted' })
    client.input(1, 'b')
    client.input(1, 'c')
    socket().close(1006)
    expect(events.results.at(-1)).toEqual({ viewerSeq: 2, status: 'uncertain', error: 'The connection dropped before your input was confirmed; anything typed after it was not sent' })
  })

  it('a rejection drops queued input of the same generation only', async () => {
    const { client, socket } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    client.input(1, 'a')
    client.input(2, 'next generation')
    socket().server({ type: 'result', viewerSeq: 1, status: 'rejected', error: 'Input ownership changed' })
    await until(() => socket().of('input').length === 2, 'generation 2 still sent')
    expect(socket().of('input').map((frame) => frame.data)).toEqual(['a', 'next generation'])
  })

  it('reconnect() replaces an open socket with a fresh one and a new sync', () => {
    const { client, socket } = setup()
    client.connect(); socket().open()
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    const first = socket()
    client.reconnect()
    expect(first.readyState).toBe(3)
    expect(FakeSocket.all).toHaveLength(2)
    socket().open()
    expect(socket().sent[0]).toEqual({ type: 'hello', clientId: 'tab-0123456789abcdef' })
  })

  it('resize reports whether it was sent', () => {
    const { client, socket } = setup()
    client.connect(); socket().open()
    expect(client.resize(1, 80, 24)).toBe(false)
    socket().server({ type: 'sync', epoch: 1, session, snapshot: '', cursor: 0 })
    expect(client.resize(1, 80, 24)).toBe(true)
  })
})

