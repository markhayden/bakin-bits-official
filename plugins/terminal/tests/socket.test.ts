import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginSocket } from '@makinbakin/sdk/types'
import { DeliveryUncertainError, TerminalError, type Principal, type Session } from '../lib/contracts'
import type { NativeClient } from '../lib/processes'
import { Store } from '../lib/store'
import { DIGEST_WINDOW_MS, digestMismatch, digestSessionsTracked, SOCKET_CLOSE, TerminalViewer, type ViewerManager } from '../lib/socket'
import type { RawSource } from '../lib/raw-display'
import { makeBundle, type Bundle } from '../lib/bundle'
import { Replica } from '../lib/replica'

const CLIENT = 'browser-0123456789abcdef'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', title: 'Live', cwd: '/tmp', program: 'shell', owner: { kind: 'human', id: 'x' }, generation: 1, inputSequence: 0,
    cols: 100, rows: 30, sizeEpoch: 0, sizeRevision: 0, state: 'running', createdAt: 0, lastActivityAt: 0, ...overrides,
  }
}

function fakeManager(initial = session(), raw: { replica?: RawSource; bundle?: Bundle } = {}) {
  let current = initial
  const sessionListeners = new Set<(session: Session) => void>()
  let natives: NativeClient[] = []
  const nativeListeners = new Set<() => void>()
  const writes: Array<{ principal: Principal; data: string; paste: boolean; enter: boolean }> = []
  let writeError: Error | undefined
  /** Raw joins' recovery calls, and what the next one throws. */
  const ensured: string[] = []
  const divergences: string[] = []
  let ensureError: Error | undefined
  let ensureStall: Promise<void> = Promise.resolve()
  const manager: ViewerManager = {
    get: (id) => { if (id !== current.id) throw new TerminalError('Session not found', 404); return current },
    onSessionChange: (_id, listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener) },
    nativeClients: () => natives,
    onNatives: (_id, listener) => { nativeListeners.add(listener); return () => nativeListeners.delete(listener) },
    writeNext: async (_id, principal, _generation, data, options) => {
      if (writeError) throw writeError
      // Like Sessions: a session that is not running takes no input.
      if (current.state !== 'running') throw new TerminalError('Session has exited')
      writes.push({ principal, data, paste: options?.paste ?? false, enter: options?.enter ?? false })
      current = { ...current, inputSequence: current.inputSequence + 1 }
      return current
    },
    claim: async () => current,
    resizeAs: async () => current,
    replica: () => raw.replica,
    bundle: async () => raw.bundle,
    diverged: (id, detail) => { divergences.push(`${id} ${detail.category} ${detail.mismatches}`) },
    ensureReplica: async (id) => { ensured.push(id); if (ensureError) throw ensureError; await ensureStall },
    fidelity: () => ({ rebuilds: {} }),
  }
  return {
    manager, writes, ensured, divergences,
    failEnsure: (error: Error) => { ensureError = error },
    stallEnsure: (until: Promise<void>) => { ensureStall = until },
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

const replicas: Replica[] = []
afterEach(() => { for (const replica of replicas.splice(0)) replica.close() })
/** A replica seeded with `ready` (closed after the test). */
async function seeded() {
  const replica = new Replica({ reseed: (_reason, turn) => turn(async () => undefined), geometry: (_generation, turn) => turn(async () => undefined), idleMs: 1e9 })
  replicas.push(replica)
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bcready'), cols: 100, rows: 30, reason: 'test', history: true })
  return replica
}
/** A running session's manager with a seeded replica. */
async function live(initial = session()) {
  return fakeManager(initial, { replica: await seeded() })
}
/** Say hello, wait for the picture's barrier, and apply its replay: input may flow. */
async function joined(peer: ReturnType<typeof fakeSocket>, clientId = CLIENT) {
  peer.client({ type: 'hello', clientId })
  await until(() => peer.of('barrier').length === 1, `${clientId} joined`)
  peer.client({ type: 'replay-applied', epoch: 1 })
}

describe('TerminalViewer', () => {
  it('closes a connection whose first message is not hello', () => {
    const { manager } = fakeManager()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'retired', bytes: 0 })
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.protocol)
  })

  it('reports accepted, rejected and uncertain input and never replays it', async () => {
    const { manager, writes, failWrites } = await live()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    await joined(peer)
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

  it('passes a paste on as one, and plain input as plain', async () => {
    const { manager, writes } = await live()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    await joined(peer)
    peer.client({ type: 'input', generation: 1, viewerSeq: 1, data: 'one\rtwo', paste: true })
    peer.client({ type: 'input', generation: 1, viewerSeq: 2, data: '\x1b[200~literal\x1b[201~' })
    peer.client({ type: 'input', generation: 1, viewerSeq: 3, data: 'ls', paste: true, enter: true })
    // Enter belongs to a paste: on plain input it means nothing.
    peer.client({ type: 'input', generation: 1, viewerSeq: 4, data: 'x', enter: true })
    await until(() => peer.of('result').length === 4, 'results')
    expect(writes.map((write) => [write.data, write.paste, write.enter])).toEqual([
      ['one\rtwo', true, false], ['\x1b[200~literal\x1b[201~', false, false], ['ls', true, true], ['x', false, false],
    ])
  })

  it('pushes session changes as they are saved', async () => {
    const { manager, change } = await live()
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    await joined(peer)
    change({ generation: 2, owner: { kind: 'agent', id: 'patch' } })
    expect(peer.of('session').at(-1)).toMatchObject({ session: { generation: 2, owner: { kind: 'agent', id: 'patch' } } })
  })

  it('a reconnect from the same client supersedes the old socket', async () => {
    const { manager } = await live()
    const old = fakeSocket()
    const fresh = fakeSocket()
    new TerminalViewer(manager, old.socket, 's1', options)
    await joined(old)
    new TerminalViewer(manager, fresh.socket, 's1', options)
    await joined(fresh)
    expect(old.state.closed?.code).toBe(SOCKET_CLOSE.superseded)
    expect(fresh.state.closed).toBeNull()
  })

  it('pings and closes a silent client', async () => {
    const { manager } = await live()
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

  it('routes claim and epoch-checked resize to the manager and reports a refused size quietly', async () => {
    const { manager } = await live()
    const calls: string[] = []
    manager.claim = async (_id, principal, cols, rows, authority) => { calls.push(`claim ${principal.id} ${cols}x${rows} ${authority.kind}/${authority.kind === 'browser' ? authority.device : ''}`); return manager.get('s1', principal) }
    manager.resizeAs = async (_id, _principal, epoch) => { calls.push(`resize @${epoch}`); throw new TerminalError('Another device is sizing this session', 409) }
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    await joined(peer)
    peer.client({ type: 'claim', cols: 120, rows: 40, device: 'phone' })
    peer.client({ type: 'resize', epoch: 2, cols: 100, rows: 30 })
    await until(() => peer.of('size-refused').length === 1, 'refusal')
    expect(calls).toEqual([`claim ${CLIENT} 120x40 browser/phone`, 'resize @2'])
    expect(peer.state.closed).toBeNull()
  })

  it('tells viewers when the sizing screen disconnects (the size freezes) and comes back', async () => {
    const AUTHORITY = 'desk-0123456789abcdef'
    const { manager } = await live(session({ sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: AUTHORITY, kind: 'browser', device: 'desktop' } }))
    const watcher = fakeSocket()
    new TerminalViewer(manager, watcher.socket, 's1', options)
    await joined(watcher)
    expect(watcher.of('join')[0]!.sizeFrozen).toBe(true)
    const desk = fakeSocket()
    new TerminalViewer(manager, desk.socket, 's1', options)
    desk.client({ type: 'hello', clientId: AUTHORITY })
    await until(() => watcher.of('presence').length === 1, 'authority arrived')
    expect(watcher.of('presence')[0]).toEqual({ type: 'presence', sizeFrozen: false, nativeClients: 0 })
    await until(() => desk.of('join').length === 1, 'authority joined')
    expect(desk.of('join')[0]!.sizeFrozen).toBe(false)
    desk.socket.close(1000)
    await until(() => watcher.of('presence').length === 2, 'authority left')
    expect(watcher.of('presence')[1]).toEqual({ type: 'presence', sizeFrozen: true, nativeClients: 0 })
  })

  it('counts terminal apps and freezes the size while the app that sizes it is gone', async () => {
    const { manager, setNatives } = await live(session({ sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: 'native:501', kind: 'native' } }))
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    await joined(peer)
    expect(peer.of('join')[0]).toMatchObject({ sizeFrozen: true, nativeClients: 0 })
    setNatives([{ pid: 501, name: '/dev/ttys001', cols: 120, rows: 40, readonly: false, control: false }])
    expect(peer.of('presence')).toEqual([{ type: 'presence', sizeFrozen: false, nativeClients: 1 }])
    setNatives([{ pid: 501, name: '/dev/ttys001', cols: 130, rows: 40, readonly: false, control: false }])
    expect(peer.of('presence')).toHaveLength(1)
    setNatives([])
    expect(peer.of('presence')[1]).toEqual({ type: 'presence', sizeFrozen: true, nativeClients: 0 })
  })

  it('re-evaluates the freeze when another screen claims the size', async () => {
    const { manager, change } = await live(session({ sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: 'gone-0123456789abcdef', kind: 'browser', device: 'phone' } }))
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    await joined(peer)
    expect(peer.of('join')[0]!.sizeFrozen).toBe(true)
    change({ sizeEpoch: 2, sizeAuthority: { viewer: CLIENT, kind: 'browser', device: 'desktop' } })
    await until(() => peer.of('presence').length === 1, 'thawed by the claim')
    expect(peer.of('presence')[0]).toEqual({ type: 'presence', sizeFrozen: false, nativeClients: 0 })
  })
})

describe('TerminalViewer pictures', () => {
  /** Display bytes as the client retires them: binary frames and text display frames (not results, pings or presence). */
  const retired = (peer: ReturnType<typeof fakeSocket>) => peer.bytes() + peer.text.filter((frame) => ['join', 'rebase', 'barrier', 'layout', 'rebuilding'].includes(String(frame.type))).reduce((n, frame) => n + Buffer.byteLength(JSON.stringify(frame)), 0)

  it('a join first recovers a lost replica; one that cannot be recovered closes for a reconnect, or 4004 when the session is gone', async () => {
    for (const [error, code] of [[new TerminalError('Terminal attachment is unavailable; reconnect required', 503), 4000], [new TerminalError('Session not found', 404), 4004]] as const) {
      const replica = await seeded()
      const { manager, ensured, failEnsure } = fakeManager(session(), { replica })
      failEnsure(error)
      const peer = fakeSocket()
      new TerminalViewer(manager, peer.socket, 's1', options)
      peer.client({ type: 'hello', clientId: CLIENT })
      await until(() => peer.state.closed !== null, 'closed')
      expect(ensured).toEqual(['s1'])
      expect(peer.state.closed?.code).toBe(code)
      expect(peer.of('join')).toEqual([])
      replica.close()
    }
  })
  it('an ended session joins from its bundle: the saved picture, its fidelity, then the barrier; no input', async () => {
    const replica = await seeded()
    await replica.event({ seq: 2, kind: 'output', offset: 0, bytes: new TextEncoder().encode(' last words') })
    const bundle = makeBundle(replica.cut()!, { rebuilds: { overload: 1 } }, 1)
    replica.close()
    const { manager, ensured } = fakeManager(session({ state: 'completed', outputSaved: true }), { bundle })
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('barrier').length === 1, 'barrier')
    expect(ensured).toEqual([])
    expect(peer.of('join')[0]).toMatchObject({ epoch: 1, session: { state: 'completed' }, fidelity: { rebuilds: { overload: 1 } } })
    expect(peer.binary.map((bytes) => Buffer.from(bytes).toString()).join('')).toContain('last words')
    // No input: the session is not running.
    peer.client({ type: 'replay-applied', epoch: 1 })
    peer.client({ type: 'input', generation: 1, viewerSeq: 1, data: 'ls\r' })
    await until(() => peer.of('result').length === 1, 'refused')
    expect(peer.of('result')[0]).toMatchObject({ status: 'rejected' })
  })
  it('a bundle that cannot be read, or whose replay fails, closes 4005 unreadable: never a stuck join or a resync loop', async () => {
    const replica = await seeded()
    const cut = replica.cut()!
    replica.close()
    // A replay that throws: an output event without its bytes (past the store's checks, as a stand-in for any replay failure).
    const broken = makeBundle({ ...cut, tail: [{ seq: 2, kind: 'output', offset: 0 } as never] }, { rebuilds: {} }, 1)
    for (const manager of [
      fakeManager(session({ state: 'completed', outputSaved: true }), { bundle: broken }).manager,
      { ...fakeManager(session({ state: 'completed', outputSaved: true }), {}).manager, bundle: async () => { throw new Error('disk error') } },
    ]) {
      const peer = fakeSocket()
      new TerminalViewer(manager, peer.socket, 's1', options)
      peer.client({ type: 'hello', clientId: CLIENT })
      await until(() => peer.state.closed !== null, 'closed')
      expect(peer.state.closed).toEqual({ code: 4005, reason: 'unreadable' })
      expect(peer.of('barrier')).toEqual([])
    }
  })
  it('a replay that fails only once credit resumes it is final too (4005 unreadable, not a reconnect)', async () => {
    const replica = await seeded()
    const cut = replica.cut()!
    replica.close()
    const broken = makeBundle({ ...cut, tail: [{ seq: 2, kind: 'output', offset: 0 } as never] }, { rebuilds: {} }, 1)
    const { manager } = fakeManager(session({ state: 'completed', outputSaved: true }), { bundle: broken })
    const peer = fakeSocket()
    // A window so small the replay pauses after its header: the broken event is reached only when credit returns.
    new TerminalViewer(manager, peer.socket, 's1', { ...options, ackWindow: 1 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('join').length === 1 || peer.state.closed !== null, 'joined')
    // Each retirement lets one more frame go, until the replay reaches the broken event.
    for (let tries = 0; tries < 50 && peer.state.closed === null; tries++) {
      peer.client({ type: 'retired', bytes: retired(peer) })
      await Bun.sleep(5)
    }
    expect(peer.state.closed).toEqual({ code: 4005, reason: 'unreadable' })
  })
  it('an ended session without its output closes 4005 with why: not saved, removed for room, or unreadable', async () => {
    for (const [fields, reason] of [[{ outputSaved: false }, 'not-saved'], [{ outputSaved: false, outputEvicted: true }, 'evicted'], [{ outputSaved: true }, 'unreadable']] as const) {
      const { manager } = fakeManager(session({ state: 'completed', ...fields }), {})
      const peer = fakeSocket()
      new TerminalViewer(manager, peer.socket, 's1', options)
      peer.client({ type: 'hello', clientId: CLIENT })
      await until(() => peer.state.closed !== null, 'closed')
      expect(peer.state.closed).toEqual({ code: 4005, reason })
      expect(peer.of('join')).toEqual([])
    }
  })
  it('a failed save, recorded and reopened: the viewer says not saved (4005), never a picture or a reconnect', async () => {
    const path = join(tmpdir(), `terminal-viewer-${crypto.randomUUID()}.db`)
    try {
      const first = new Store(path)
      first.save(session({ state: 'running', outputSaved: false }))
      // What Sessions records when the final picture did not come in time, then the kill.
      first.markOutput('s1', false)
      first.save({ ...first.session('s1')!, state: 'completed' })
      first.close()
      const reopened = new Store(path)
      const { manager } = fakeManager(reopened.session('s1')!, { bundle: await reopened.bundle('s1') })
      const peer = fakeSocket()
      new TerminalViewer(manager, peer.socket, 's1', options)
      peer.client({ type: 'hello', clientId: CLIENT })
      await until(() => peer.state.closed !== null, 'closed')
      expect(peer.state.closed).toEqual({ code: 4005, reason: 'not-saved' })
      reopened.close()
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
    }
  })
  it('the safety net (plan T37): a quiet live picture gets a digest point; a matching report is left alone, a mismatching one rejoins the viewer', async () => {
    const replica = await seeded()
    for (const honest of [true, false]) {
      const { manager } = fakeManager(session(), { replica })
      const peer = fakeSocket()
      new TerminalViewer(manager, peer.socket, `s1`, { ...options, digestTickMs: 10, digestQuietMs: 0 })
      peer.client({ type: 'hello', clientId: CLIENT })
      await until(() => peer.of('barrier').length === 1, 'barrier')
      await until(() => peer.of('digest-point').length === 1, 'a digest point')
      const point = peer.of('digest-point')[0] as { epoch: number; seq: number }
      expect(point).toMatchObject({ epoch: 1, seq: 1 })
      const truth = (await replica.digest())!.digest
      peer.client({ type: 'digest', epoch: point.epoch, seq: point.seq, digest: honest ? truth : 'deadbeef' })
      if (honest) {
        await Bun.sleep(30)
        expect(peer.state.closed).toBeNull()
        // The same position is not asked again.
        expect(peer.of('digest-point')).toHaveLength(1)
        peer.socket.close?.(1000, '')
      } else {
        await until(() => peer.state.closed !== null, 'rejoin')
        expect(peer.state.closed).toEqual({ code: 4000, reason: 'Display differed from the terminal; rejoin' })
      }
    }
    replica.close()
  })
  it('mismatches per session: each rejoins, the third escalates once (a replica rebuild), more within the window are left alone', () => {
    const at = Date.now()
    const id = `window-${at}`
    expect([1, 2, 3, 4, 5].map((n) => digestMismatch(id, at + n))).toEqual(['rejoin', 'rejoin', 'escalate', 'bounded', 'bounded'])
    // Past the window from the escalation it starts over.
    expect(digestMismatch(id, at + 3 + DIGEST_WINDOW_MS)).toBe('rejoin')
  })
  it('escalation is once a window, even as older mismatches expire one by one (staggered viewers, reconnects)', () => {
    const at = Date.now() + 1e9
    const id = `staggered-${at}`
    expect([0, 300_000, 599_999, 600_001].map((offset) => digestMismatch(id, at + offset))).toEqual(['rejoin', 'rejoin', 'escalate', 'bounded'])
  })
  it('the bookkeeping drops sessions with nothing recent', () => {
    const at = Date.now() + 2e9
    for (let n = 0; n < 50; n++) digestMismatch(`old-${at}-${n}`, at)
    const before = digestSessionsTracked()
    digestMismatch(`new-${at}`, at + DIGEST_WINDOW_MS + 1)
    expect(digestSessionsTracked()).toBeLessThan(before)
    expect(digestSessionsTracked()).toBeLessThanOrEqual(1)
  })
  it('a viewer closed while its picture starts (an ended source) leaves no digest timer', async () => {
    const replica = await seeded()
    replica.close()
    const { manager } = fakeManager(session(), { replica })
    const intervals: number[] = []
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    globalThis.setInterval = ((fn: () => void, ms: number) => { const timer = realSet(fn, ms); intervals.push(Number(timer)); return timer }) as typeof setInterval
    globalThis.clearInterval = ((timer: number) => { const index = intervals.indexOf(Number(timer)); if (index >= 0) intervals.splice(index, 1); realClear(timer) }) as typeof clearInterval
    try {
      const peer = fakeSocket()
      new TerminalViewer(manager, peer.socket, 's1', { ...options, digestTickMs: 10 })
      peer.client({ type: 'hello', clientId: CLIENT })
      await until(() => peer.state.closed !== null, 'closed')
      await Bun.sleep(20)
      expect(intervals).toEqual([])
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })
  it('a recovery slower than the join deadline closes for a reconnect at the deadline, nothing of a picture sent', async () => {
    const replica = await seeded()
    const { manager, stallEnsure } = fakeManager(session(), { replica })
    stallEnsure(new Promise<void>(() => {}))
    const peer = fakeSocket()
    const started = performance.now()
    new TerminalViewer(manager, peer.socket, 's1', { ...options, replicaWaitMs: 150 })
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.state.closed !== null, 'closed')
    expect(performance.now() - started).toBeLessThan(1000)
    expect(peer.state.closed).toEqual({ code: 4000, reason: 'Terminal output not ready; reconnect' })
    expect(peer.of('join')).toEqual([])
    replica.close()
  })
  it('joins from the replica, refuses input until the replay is applied, then accepts it', async () => {
    const replica = await seeded()
    const { manager, writes, ensured } = fakeManager(session(), { replica })
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('barrier').length === 1, 'barrier')
    expect(ensured).toEqual(['s1'])
    expect(peer.of('join')[0]).toMatchObject({ epoch: 1, bytes: 7, baseSeq: 1, throughSeq: 1, session: { id: 's1' }, sizeFrozen: false, fidelity: { rebuilds: {} } })
    expect(Buffer.from(peer.binary[0]!).toString()).toBe('\x1bcready')
    peer.client({ type: 'input', generation: 1, viewerSeq: 1, data: 'early' })
    await until(() => peer.of('result').length === 1, 'refused')
    expect(peer.of('result')[0]).toMatchObject({ status: 'rejected', error: expect.stringContaining('Joining') })
    peer.client({ type: 'replay-applied', epoch: 1 })
    peer.client({ type: 'input', generation: 1, viewerSeq: 1, data: 'ls\r' })
    await until(() => peer.of('result').length === 2, 'accepted')
    expect(writes.map((write) => write.data)).toEqual(['ls\r'])
    // Live output follows the barrier; retiring it keeps the window open.
    await replica.event({ seq: 2, kind: 'output', offset: 0, bytes: new TextEncoder().encode('live') })
    expect(Buffer.from(peer.binary.at(-1)!).toString()).toBe('live')
    peer.client({ type: 'retired', bytes: retired(peer) })
    replica.close()
  })
  it('a stalled viewer is held to its window while a healthy one gets every byte', async () => {
    const replica = await seeded()
    const { manager } = fakeManager(session(), { replica })
    const stalled = fakeSocket()
    const healthy = fakeSocket()
    new TerminalViewer(manager, stalled.socket, 's1', { ...options, pauseEvictMs: 60_000 })
    new TerminalViewer(manager, healthy.socket, 's1', { ...options, pauseEvictMs: 60_000 })
    stalled.client({ type: 'hello', clientId: 'stalled-raw-0123456789' })
    healthy.client({ type: 'hello', clientId: 'healthy-raw-0123456789' })
    await until(() => stalled.of('barrier').length === 1 && healthy.of('barrier').length === 1, 'both joined')
    const start = healthy.bytes()
    const chunk = new Uint8Array(64 * 1024).fill(0x61)
    for (let seq = 2; seq < 2 + 64; seq++) {
      await replica.event({ seq, kind: 'output', offset: 0, bytes: chunk })
      healthy.client({ type: 'retired', bytes: retired(healthy) })
    }
    // The healthy one has all 4 MiB; the stalled one no more than a window and a frame.
    expect(healthy.bytes() - start).toBe(64 * 64 * 1024)
    expect(stalled.bytes()).toBeLessThanOrEqual(256 * 1024 + 64 * 1024)
    replica.close()
  })
  it('keeps input through a rebase (decision 3) and sends the rebase in order', async () => {
    const replica = await seeded()
    const { manager, writes } = fakeManager(session(), { replica })
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('barrier').length === 1, 'barrier')
    peer.client({ type: 'replay-applied', epoch: 1 })
    replica.pressure(4 * 1024 * 1024)
    await until(() => peer.of('rebuilding').length === 1, 'rebuilding notice')
    peer.client({ type: 'input', generation: 1, viewerSeq: 1, data: '\x03' })
    await until(() => peer.of('result').length === 1, 'Ctrl-C while rebuilding')
    expect(peer.of('result')[0]!.status).toBe('accepted')
    await replica.event({ seq: 2, kind: 'seed', bytes: new TextEncoder().encode('\x1bcafter'), cols: 100, rows: 30, reason: 'overload', history: true })
    await until(() => peer.of('rebase').length === 1, 'rebase', )
    expect(peer.of('rebase')[0]).toMatchObject({ epoch: 2, baseSeq: 2 })
    expect(writes.map((write) => write.data)).toEqual(['\x03'])
    replica.close()
  })
  it('closes 4000 when the session stops running, and when no replica comes in time', async () => {
    const replica = await seeded()
    const { manager, change } = fakeManager(session(), { replica })
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.of('barrier').length === 1, 'barrier')
    change({ state: 'exited' })
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.resync)
    replica.close()
    const waiting = fakeManager(session(), {})
    const late = fakeSocket()
    new TerminalViewer(waiting.manager, late.socket, 's1', { ...options, replicaWaitMs: 150 })
    late.client({ type: 'hello', clientId: CLIENT })
    late.client({ type: 'input', generation: 1, viewerSeq: 1, data: 'x' })
    await until(() => late.of('result').length === 1, 'refused while waiting')
    expect(late.of('result')[0]!.status).toBe('rejected')
    await until(() => late.state.closed !== null, 'no replica')
    expect(late.state.closed?.code).toBe(SOCKET_CLOSE.resync)
  })
  it('a session gone when the picture is described closes 4004 with nothing of the picture sent', async () => {
    const replica = await seeded()
    const { manager } = fakeManager(session(), { replica })
    let gone = false
    const get = manager.get
    manager.get = (id, principal) => { if (gone) throw new TerminalError('Session not found', 404); return get(id, principal) }
    // The replica is found, and the session goes before its header is made.
    manager.replica = () => { gone = true; return replica }
    const peer = fakeSocket()
    new TerminalViewer(manager, peer.socket, 's1', options)
    peer.client({ type: 'hello', clientId: CLIENT })
    await until(() => peer.state.closed !== null, 'closed')
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.notFound)
    expect(peer.text.filter((frame) => ['join', 'barrier'].includes(String(frame.type)))).toEqual([])
    expect(peer.binary).toEqual([])
    replica.close()
  })
  it('one deadline from the hello covers the replica arriving and its seed', async () => {
    const seeding = new Replica({ reseed: (_reason, turn) => turn(async () => undefined), geometry: (_generation, turn) => turn(async () => undefined), idleMs: 1e9 })
    const raw: { replica?: RawSource } = {}
    const { manager } = fakeManager(session(), raw)
    const peer = fakeSocket()
    let now = 0
    new TerminalViewer(manager, peer.socket, 's1', { ...options, replicaWaitMs: 10_000, now: () => now })
    peer.client({ type: 'hello', clientId: CLIENT })
    // The replica arrives (seeding forever) at 9.9 s of the 10 s: what is left is 100 ms, not a fresh 10 s.
    now = 9_900
    raw.replica = seeding
    const found = Date.now()
    await until(() => peer.state.closed !== null, 'deadline')
    expect(Date.now() - found).toBeLessThan(400)
    expect(peer.state.closed?.code).toBe(SOCKET_CLOSE.resync)
    seeding.close()
  })
  it('a replica found only after the deadline closes at once', async () => {
    const seeded = new Replica({ reseed: (_reason, turn) => turn(async () => undefined), geometry: (_generation, turn) => turn(async () => undefined), idleMs: 1e9 })
    await seeded.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bc'), cols: 100, rows: 30, reason: 'test', history: true })
    const raw: { replica?: RawSource } = {}
    const { manager } = fakeManager(session(), raw)
    const peer = fakeSocket()
    let now = 0
    new TerminalViewer(manager, peer.socket, 's1', { ...options, replicaWaitMs: 10_000, now: () => now })
    peer.client({ type: 'hello', clientId: CLIENT })
    now = 10_001
    raw.replica = seeded
    await until(() => peer.state.closed !== null, 'closed')
    expect(peer.of('join')).toEqual([])
    seeded.close()
  })
})
