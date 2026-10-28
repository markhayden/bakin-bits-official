import { afterEach, expect, test } from 'bun:test'
import type { ProcessDriver } from '../lib/processes'
import { Replica } from '../lib/replica'
import { Sessions, SHADOW_LOG_MS } from '../lib/sessions'
import { Store } from '../lib/store'

const human = { kind: 'human', id: 'browser' } as const
const encode = (text: string) => new TextEncoder().encode(text)
const managers: Sessions[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown() })

/** A driver whose bridge output and replica events the test sends by hand. */
function fixture(quietMs = 10) {
  let now = 1000
  let bridge: ((data: Uint8Array) => void) | undefined
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {} })
  let seq = 0
  const logs: { message: string; data?: Record<string, unknown> }[] = []
  const driver: ProcessDriver = {
    create: async () => {}, attach: (_s, output) => { bridge = output }, connected: () => true,
    write: async () => {}, resize: async () => {}, windowSize: async () => ({ cols: 20, rows: 4 }),
    title: async () => {}, alive: async () => true, screen: async () => '', terminate: async () => {}, inUse: async () => false,
    detach: async () => {}, clients: async () => [], detachClient: async () => {}, setReadonly: async () => {}, attachArgs: () => [],
    replica: () => replica,
  }
  const manager = new Sessions(new Store(':memory:'), driver, {
    settings: () => ({}), now: () => now, prepare: async () => undefined, release: async () => undefined,
    log: { info: (message, data) => logs.push({ message, data }) }, shadowQuietMs: quietMs,
  })
  managers.push(manager)
  return {
    manager, logs, replica,
    advance: (ms: number) => { now += ms },
    bridge: (text: string) => bridge!(encode(text)),
    raw: (text: string) => replica.event({ seq: ++seq, kind: 'output', offset: 0, bytes: encode(text) }),
    seed: () => replica.event({ seq: ++seq, kind: 'seed', bytes: encode('\x1bc'), cols: 20, rows: 4, reason: 'test', history: true }),
  }
}
const compared = async (manager: Sessions, id: string, count: number) => {
  for (let attempt = 0; attempt < 100 && (manager.shadow.get(id)?.compared ?? 0) < count; attempt++) await Bun.sleep(5)
  expect(manager.shadow.get(id)?.compared).toBe(count)
}

test('at a quiet point the shadow replica is compared with the bridge; a mismatch is counted and logged without contents, once per window', async () => {
  const f = fixture()
  const session = await f.manager.create({ title: 'Shadow', cwd: '/tmp', program: 'shell' }, human, { cols: 20, rows: 4, kind: 'browser', device: 'desktop' })
  await f.seed()
  await f.raw('same text')
  f.bridge('same text')
  await compared(f.manager, session.id, 1)
  expect(f.manager.shadow.get(session.id)!.mismatched).toBe(0)
  expect(f.logs).toEqual([])

  await f.raw('\r\nsecret replica line')
  f.bridge('\r\nsecret bridge line')
  await compared(f.manager, session.id, 2)
  expect(f.manager.shadow.get(session.id)).toMatchObject({ mismatched: 1, last: 'row 1' })
  expect(f.logs.length).toBe(1)
  expect(f.logs[0]!.data).toMatchObject({ sessionId: session.id, mismatch: 'row 1', compared: 2, mismatched: 1 })
  expect(JSON.stringify(f.logs)).not.toContain('secret')

  // Within the window: counted, not logged again.
  f.bridge('!')
  await compared(f.manager, session.id, 3)
  expect(f.manager.shadow.get(session.id)!.mismatched).toBe(2)
  expect(f.logs.length).toBe(1)
  f.advance(SHADOW_LOG_MS)
  f.bridge('!')
  await compared(f.manager, session.id, 4)
  expect(f.logs.length).toBe(2)
})

test('nothing is compared while the replica waits for a seed', async () => {
  const f = fixture()
  const session = await f.manager.create({ title: 'Unseeded', cwd: '/tmp', program: 'shell' }, human, { cols: 20, rows: 4, kind: 'browser', device: 'desktop' })
  f.bridge('output before any seed')
  await Bun.sleep(60)
  expect(f.manager.shadow.get(session.id)).toBeUndefined()
  expect(f.logs).toEqual([])
})

test('a replica that moved just before the quiet point is not compared until the bridge has caught up', async () => {
  const f = fixture(100)
  const session = await f.manager.create({ title: 'Delayed', cwd: '/tmp', program: 'shell' }, human, { cols: 20, rows: 4, kind: 'browser', device: 'desktop' })
  await f.seed()
  await f.raw('A')
  f.bridge('A')
  await compared(f.manager, session.id, 1)
  // The bridge's quiet point is near (a chunk that changes nothing on screen); the program prints, and the bridge's redraw comes later.
  f.bridge('\x1b[0m')
  await Bun.sleep(80)
  await f.raw('B')
  await Bun.sleep(40)
  f.bridge('B')
  await compared(f.manager, session.id, 2)
  expect(f.manager.shadow.get(session.id)).toMatchObject({ compared: 2, mismatched: 0 })
})

test('bridge output parsed after shutdown leaves no shadow bookkeeping behind', async () => {
  const f = fixture()
  const session = await f.manager.create({ title: 'Teardown', cwd: '/tmp', program: 'shell' }, human, { cols: 20, rows: 4, kind: 'browser', device: 'desktop' })
  await f.seed()
  f.bridge('pending at shutdown')
  await f.manager.shutdown()
  const internals = f.manager as unknown as { bridgeChunks: Map<string, number>; shadowTimers: Map<string, unknown> }
  expect(internals.bridgeChunks.size).toBe(0)
  expect(internals.shadowTimers.size).toBe(0)
  await Bun.sleep(30)
  expect(f.manager.shadow.get(session.id)).toBeUndefined()
})
