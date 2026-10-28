import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store'
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
test('output rolls at session and global byte limits and reports gaps', () => {
  const store = new Store(':memory:', 8, 12)
  stores.push(store)
  store.append('one', Buffer.from('123456'))
  store.append('one', Buffer.from('abcdef'))
  expect(store.output('one', 0).truncated).toBe(true)
  expect(store.output('one', 0).data.toString()).toBe('abcdef')
  store.append('two', Buffer.from('ABCDEF'))
  store.append('three', Buffer.from('uvwxyz'))
  expect(store.output('one', 0).data.length).toBe(0)
  expect(store.output('one', 0).truncated).toBe(true)
  expect(store.bytes()).toBeLessThanOrEqual(12)
})
test('deleteSession removes the row, its output, and its cursor', () => {
  const store = new Store(':memory:')
  stores.push(store)
  store.save({ id: 'gone', title: 'Gone', cwd: '/tmp', program: 'shell', owner: { kind: 'human', id: 'h' }, generation: 1, inputSequence: 0, cols: 80, rows: 24, sizeEpoch: 0, sizeRevision: 0, state: 'completed', createdAt: 1, lastActivityAt: 1 })
  store.append('gone', Buffer.from('output'))
  store.deleteSession('gone')
  expect(store.sessions()).toHaveLength(0)
  expect(store.bytes('gone')).toBe(0)
  expect(store.output('gone', 0)).toMatchObject({ cursor: 0, truncated: false })
})
test('appending at the retention limit costs the same as appending below it (no scans of retained output)', () => {
  const store = new Store(':memory:')
  stores.push(store)
  const chunk = new Uint8Array(400).fill(0x41)
  const start = performance.now()
  // 16 MB through a 10 MiB session limit: most appends trim.
  for (let i = 0; i < 40_000; i++) store.append('busy', chunk)
  const elapsed = performance.now() - start
  expect(store.bytes('busy')).toBeLessThanOrEqual(10 * 1024 * 1024)
  expect(store.bytes('busy')).toBeGreaterThan(10 * 1024 * 1024 - 400)
  expect(store.bytes()).toBe(store.bytes('busy'))
  // Measured: about 0.3 s with running totals; the per-append SUM took minutes.
  expect(elapsed).toBeLessThan(5000)
})
test('retained totals survive a reopen: they are rebuilt from the output', () => {
  const path = join(tmpdir(), `bakin-store-${Date.now()}-${Math.random()}.db`)
  const first = new Store(path, 100, 1000)
  first.append('a', Buffer.from('x'.repeat(60)))
  first.append('a', Buffer.from('y'.repeat(60)))
  first.append('b', Buffer.from('z'.repeat(30)))
  const kept = first.bytes('a')
  first.close()
  const second = new Store(path, 100, 1000)
  stores.push(second)
  expect(second.bytes('a')).toBe(kept)
  expect(second.bytes()).toBe(kept + 30)
  second.deleteOutput('a')
  expect(second.bytes()).toBe(30)
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true })
})
