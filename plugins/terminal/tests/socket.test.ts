import { describe, expect, it } from 'bun:test'
import type { PluginSocket } from '@makinbakin/sdk/types'
import { DeliveryUncertainError, TerminalError, type Principal, type Session } from '../lib/contracts'
import type { NativeClient } from '../lib/processes'
import { SOCKET_CLOSE, TerminalViewer, type ViewerManager } from '../lib/socket'

const CLIENT = 'browser-0123456789abcdef'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', title: 'Live', cwd: '/tmp', program: 'shell', owner: { kind: 'human', id: 'x' }, generation: 1, inputSequence: 0,
    cols: 100, rows: 30, sizeEpoch: 0, sizeRevision: 0, state: 'running', createdAt: 0, lastActivityAt: 0, ...overrides,
  }
}

function fakeManager(initial = session()) {
  let current = initial
  const chunks: Buffer[] = []
  let floor = 0
  const outputWaiters = new Set<() => void>()
  const sessionListeners = new Set<(session: Session) => void>()
  let natives: NativeClient[] = []
  const nativeListeners = new Set<() => void>()
  const writes: Array<{ principal: Principal; data: string }> = []
  let writeError: Error | undefined
  const manager: ViewerManager = {
    get: (id) => { if (id !== current.id) throw new TerminalError('Session not found', 404); return current },
    screen: async () => ({ session: current, data: 'SNAPSHOT', cursor: chunks.length }),
    outputPage: (_id, _principal, cursor, limit = 256 * 1024) => {
      const truncated = cursor < floor
      const from = Math.max(cursor, floor)
      const selected: Buffer[] = []
      let size = 0
      for (let index = from; index < chunks.length; index++) {
        if (selected.length && size + chunks[index]!.length > limit) break
        selected.push(chunks[index]!)
        size += chunks[index]!.length
      }
      return { session: current, cursor: from + selected.length, data: Buffer.concat(selected), truncated }
    },
    nextOutput: (_id, cursor, signal) => new Promise<void>((resolve) => {
      if (chunks.length > cursor || signal.aborted) { resolve(); return }
      const done = () => { outputWaiters.delete(done); resolve() }
      outputWaiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    }),
    onSessionChange: (_id, listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener) },
    nativeClients: () => natives,
    onNatives: (_id, listener) => { nativeListeners.add(listener); return () => nativeListeners.delete(listener) },
    writeNext: async (_id, principal, _generation, data) => {
      if (writeError) throw writeError
      writes.push({ principal, data })
      current = { ...current, inputSequence: current.inputSequence + 1 }
      return current
    },
    claim: async () => current,
    resizeAs: async () => current,
  }
  return {
    manager, writes,
    push: (data: string | Buffer) => { chunks.push(Buffer.from(data)); for (const wake of [...outputWaiters]) wake() },
    roll: (to: number) => { floor = to },
    change: (next: Partial<Session>) => { current = { ...current, ...next }; for (const listener of sessionListeners) listener(current) },
    failWrites: (error: Error) => { writeError = error },
    setNatives: (next: NativeClient[]) => { natives = next; for (const listener of nativeListeners) listener() },
  }
}

function fakeSocket() {
  const text: Array<Record<string, unknown>> = []
  const binary: Uint8Array[] = []
  let message: (data: string | Uint8Array) => void = () => {}
  let closeListener: (code: number, reason: string) => void = () => {}
  const state = { closed: null as null | { code: number; reason: string } }
  const socket: PluginSocket = {
    send: (data) => {
      if (state.closed) return false
      if (typeof data === 'string') text.push(JSON.parse(data))
      else binary.push(data)
      return true
    },
    onMessage: (listener) => { message = listener },
    onClose: (listener) => { closeListener = listener },
    close: (code = 1000, reason = '') => { if (!state.closed) { state.closed = { code, reason }; closeListener(code, reason) } },
  }
  return {
    socket, text, binary, state,
    client: (payload: unknown) => message(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    bytes: () => binary.reduce((total, frame) => total + frame.byteLength, 0),
    of: (type: string) => text.filter((frame) => frame.type === type),
  }
}

async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await Bun.sleep(5) }
  throw new Error(`timed out: ${label}`)
}

const options = { heartbeatMs: 60_000, silenceCloseMs: 120_000 }

describe('TerminalViewer', () => {
  it('requires hello first, then sends an atomic sync and the output after it', async () => {
    const { manager, push } = fakeManager()
    push('before snapshot')
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    expect(peer.of('sync')[0]).toMatchObject({ type: 'sync', snapshot: Buffer.from('SNAPSHOT').toString('base64'), cursor: 1, session: { inputSequence: 0, generation: 1, cols: 100, rows: 30 } })
    push('after')
    await until(() => peer.bytes() === 5, 'output after the snapshot cursor only')
    expect(Buffer.from(peer.binary[0]!).toString()).toBe('after')
  })

  it('closes a connection whose first message is not hello', () => {
    const { manager } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'ack', epoch: 1, bytes: 0 })
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.protocol)
  })

  it('pauses output at the ACK window and resumes when the client acknowledges', async () => {
    const { manager, push } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', { ...options, ackWindow: 1000, pauseEvictMs: 60_000 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    for (let index = 0; index < 5; index++) push(Buffer.alloc(600))
    await until(() => peer.bytes() >= 1000, 'first window')
    await Bun.sleep(30)
    expect(peer.bytes()).toBe(1200)
    // Each acknowledgement opens one more window; acking as it renders drains the rest.
    peer.client({ type: 'ack', epoch: peer.of('sync')[0]!.epoch, bytes: 1200 })
    await until(() => peer.bytes() === 2400, 'second window after the ack')
    await Bun.sleep(30)
    expect(peer.bytes()).toBe(2400)
    peer.client({ type: 'ack', epoch: peer.of('sync')[0]!.epoch, bytes: 2400 })
    await until(() => peer.bytes() === 3000, 'rest after the next ack')
  })

  it('evicts a viewer that stays paused, so it reconnects and resyncs', async () => {
    const { manager, push } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', { ...options, ackWindow: 100, pauseEvictMs: 40 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    push(Buffer.alloc(500))
    await until(() => peer.state.closed !== null, 'eviction')
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.resync)
  })

  it('bounds what a stalled viewer receives during a flood while a healthy one keeps up', async () => {
    const { manager, push } = fakeManager()
    const stalled = fakeSocket()
    const healthy = fakeSocket()
    new TerminalViewer(manager, stalled.socket, 's1', { ...options, pauseEvictMs: 60_000 })
    new TerminalViewer(manager, healthy.socket, 's1', { ...options, pauseEvictMs: 60_000 })
    stalled.client({ type: 'hello', clientId: 'stalled-0123456789abc' })
    healthy.client({ type: 'hello', clientId: 'healthy-0123456789abc' })
    await until(() => stalled.of('sync').length === 1 && healthy.of('sync').length === 1, 'both synced')
    const total = 8 * 1024 * 1024
    for (let sent = 0; sent < total; sent += 64 * 1024) {
      push(Buffer.alloc(64 * 1024))
      healthy.client({ type: 'ack', epoch: healthy.of('sync')[0]!.epoch, bytes: healthy.bytes() })
      await Bun.sleep(0)
    }
    await until(() => { healthy.client({ type: 'ack', epoch: healthy.of('sync')[0]!.epoch, bytes: healthy.bytes() }); return healthy.bytes() === total }, 'healthy viewer receives everything')
    expect(stalled.bytes()).toBeLessThanOrEqual(256 * 1024 + 64 * 1024)
  })

  it('reports accepted, rejected and uncertain input and never replays it', async () => {
    const { manager, writes, failWrites } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    peer.client({ type: 'input', generation: 1, viewerSeq: 1, data: 'ls\r' })
    await until(() => peer.of('result').length === 1, 'first result')
    peer.client({ type: 'input', generation: 1, viewerSeq: 3, data: 'skipped' })
    await until(() => peer.of('result').length === 2, 'out of order')
    failWrites(new DeliveryUncertainError('Terminal control connection closed'))
    peer.client({ type: 'input', generation: 1, viewerSeq: 2, data: 'pwd\r' })
    await until(() => peer.of('result').length === 3, 'uncertain')
    failWrites(new TerminalError('Input ownership changed; refresh the session'))
    peer.client({ type: 'input', generation: 1, viewerSeq: 3, data: 'whoami\r' })
    await until(() => peer.of('result').length === 4, 'rejected')
    expect(peer.of('result').map((result) => [result.viewerSeq, result.status])).toEqual([[1, 'accepted'], [3, 'rejected'], [2, 'uncertain'], [3, 'rejected']])
    expect(writes.map((write) => write.data)).toEqual(['ls\r'])
    expect(writes[0]!.principal).toEqual({ kind: 'human', id: CLIENT })
  })

  it('pushes session changes as they are saved', async () => {
    const { manager, change } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    change({ generation: 2, owner: { kind: 'agent', id: 'patch' } })
    expect(peer.of('session').at(-1)).toMatchObject({ session: { generation: 2, owner: { kind: 'agent', id: 'patch' } } })
  })

  it('a reconnect from the same client supersedes the old socket', async () => {
    const { manager } = fakeManager()
    const old = fakeSocket()
    const fresh = fakeSocket()
    new TerminalViewer(manager, old.socket, 's1', options)
    old.client({ type: 'hello', clientId: CLIENT })
    await until(() => old.of('sync').length === 1, 'old sync')
    new TerminalViewer(manager, fresh.socket, 's1', options)
    fresh.client({ type: 'hello', clientId: CLIENT })
    await until(() => fresh.of('sync').length === 1, 'fresh sync')
    expect(old.state.closed?.code).toBe(SOCKET_CLOSE.superseded)
    expect(fresh.state.closed).toBeNull()
    expect((fresh.of('sync')[0]!.epoch as number)).toBeGreaterThan(old.of('sync')[0]!.epoch as number)
  })

  it('resyncs from a fresh snapshot when output rolled past the viewer', async () => {
    const { manager, push, roll } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', { ...options, ackWindow: 10, pauseEvictMs: 60_000 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    push(Buffer.alloc(20)); push('lost'); push('kept')
    await until(() => peer.bytes() === 20, 'paused after the first chunk')
    roll(3)
    peer.client({ type: 'ack', epoch: peer.of('sync')[0]!.epoch, bytes: 20 })
    await until(() => peer.of('sync').length === 2, 'resync')
    expect(peer.of('sync')[1]!.cursor).toBe(3)
  })

  it('pings and closes a silent client', async () => {
    const { manager } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', { heartbeatMs: 10, silenceCloseMs: 40 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('ping').length > 0, 'ping')
    await until(() => peer.state.closed !== null, 'silence close')
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.silent)
  })

  it('closes 4004 for a session the client cannot see', async () => {
    const { manager } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 'other', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.state.closed !== null, 'not found')
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.notFound)
  })

  it('ignores acknowledgements for an older epoch', async () => {
    const { manager, push, roll } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', { ...options, ackWindow: 10, pauseEvictMs: 60_000 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    const firstEpoch = peer.of('sync')[0]!.epoch
    push(Buffer.alloc(20)); push('x'); push('y')
    await until(() => peer.bytes() === 20, 'paused')
    roll(3)
    peer.client({ type: 'ack', epoch: firstEpoch, bytes: 20 })
    await until(() => peer.of('sync').length === 2, 'resync after the gap')
    push(Buffer.alloc(20)); push('after')
    await until(() => peer.bytes() === 40, 'first window of the new epoch')
    // A late ack from the old epoch must not open the new window.
    peer.client({ type: 'ack', epoch: firstEpoch, bytes: 40 })
    await Bun.sleep(30)
    expect(peer.bytes()).toBe(40)
    peer.client({ type: 'ack', epoch: peer.of('sync')[1]!.epoch, bytes: 20 })
    await until(() => peer.bytes() === 45, 'new-epoch ack opens it')
  })

  it('closes for a resync (not not-found) when the snapshot or attachment fails', async () => {
    const broken = fakeManager()
    broken.manager.screen = async () => { throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503) }
    const peer = fakeSocket()
    new TerminalViewer(broken.manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.state.closed !== null, 'closed')
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.resync)
    const flaky = fakeManager()
    flaky.manager.outputPage = () => { throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503) }
    const other = fakeSocket()
    new TerminalViewer(flaky.manager, other.socket, 's1', options)
    other.client({ type: 'hello', clientId: 'other-0123456789abcdef' })
    await until(() => other.state.closed !== null, 'closed on output failure')
    expect(other.state.closed?.code).toBe(SOCKET_CLOSE.resync)
  })

  it('routes claim and epoch-checked resize to the manager and reports a refused size quietly', async () => {
    const { manager } = fakeManager()
    const calls: string[] = []
    manager.claim = async (_id, principal, cols, rows, authority) => { calls.push(`claim ${principal.id} ${cols}x${rows} ${authority.kind}/${authority.kind === 'browser' ? authority.device : ''}`); return manager.get('s1', principal) }
    manager.resizeAs = async (_id, _principal, epoch) => { calls.push(`resize @${epoch}`); throw new TerminalError('Another device is sizing this session', 409) }
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    peer.client({ type: 'claim', cols: 120, rows: 40, device: 'phone' })
    peer.client({ type: 'resize', epoch: 2, cols: 100, rows: 30 })
    await until(() => peer.of('size-refused').length === 1, 'refusal')
    expect(calls).toEqual([`claim ${CLIENT} 120x40 browser/phone`, 'resize @2'])
    expect(peer.state.closed).toBeNull()
  })

  it('tells viewers when the sizing screen disconnects (the size freezes) and comes back', async () => {
    const AUTHORITY = 'desk-0123456789abcdef'
    const { manager } = fakeManager(session({ sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: AUTHORITY, kind: 'browser', device: 'desktop' } }))
    const watcher = fakeSocket()
    new TerminalViewer(manager, watcher.socket, 's1', options)
    watcher.client({ type: 'hello', clientId: CLIENT })
    await until(() => watcher.of('sync').length === 1, 'watcher sync')
    expect(watcher.of('sync')[0]!.sizeFrozen).toBe(true)
    const desk = fakeSocket()
    new TerminalViewer(manager, desk.socket, 's1', options)
    desk.client({ type: 'hello', clientId: AUTHORITY })
    await until(() => watcher.of('presence').length === 1, 'authority arrived')
    expect(watcher.of('presence')[0]).toEqual({ type: 'presence', sizeFrozen: false, nativeClients: 0 })
    await until(() => desk.of('sync').length === 1, 'authority sync')
    expect(desk.of('sync')[0]!.sizeFrozen).toBe(false)
    desk.socket.close(1000)
    await until(() => watcher.of('presence').length === 2, 'authority left')
    expect(watcher.of('presence')[1]).toEqual({ type: 'presence', sizeFrozen: true, nativeClients: 0 })
  })

  it('counts terminal apps and freezes the size while the app that sizes it is gone', async () => {
    const { manager, setNatives } = fakeManager(session({ sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: 'native:501', kind: 'native' } }))
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    expect(peer.of('sync')[0]).toMatchObject({ sizeFrozen: true, nativeClients: 0 })
    setNatives([{ pid: 501, name: '/dev/ttys001', cols: 120, rows: 40 }])
    expect(peer.of('presence')).toEqual([{ type: 'presence', sizeFrozen: false, nativeClients: 1 }])
    setNatives([{ pid: 501, name: '/dev/ttys001', cols: 130, rows: 40 }])
    expect(peer.of('presence')).toHaveLength(1)
    setNatives([])
    expect(peer.of('presence')[1]).toEqual({ type: 'presence', sizeFrozen: true, nativeClients: 0 })
  })

  it('re-evaluates the freeze when another screen claims the size', async () => {
    const { manager, change } = fakeManager(session({ sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: 'gone-0123456789abcdef', kind: 'browser', device: 'phone' } }))
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('sync').length === 1, 'sync')
    expect(peer.of('sync')[0]!.sizeFrozen).toBe(true)
    change({ sizeEpoch: 2, sizeAuthority: { viewer: CLIENT, kind: 'browser', device: 'desktop' } })
    await until(() => peer.of('presence').length === 1, 'thawed by the claim')
    expect(peer.of('presence')[0]).toEqual({ type: 'presence', sizeFrozen: false, nativeClients: 0 })
  })
})
