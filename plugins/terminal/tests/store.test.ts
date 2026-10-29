import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store'
import { makeBundle, type Bundle } from '../lib/bundle'
import { Replica } from '../lib/replica'
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
  // Measured on the M4: about 0.5 s with running totals; the per-append SUM took 88 s.
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

/** A bundle whose checkpoint text is about `chars` long (a picture as big as the test needs). */
async function bundle(text: string, savedAt = 1, chars = 0): Promise<Bundle> {
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode(`\x1bc${text}`), cols: 80, rows: 24, reason: 'test', history: true })
  await replica.event({ seq: 2, kind: 'output', offset: 0, bytes: new TextEncoder().encode(' tail') })
  const cut = replica.cut()!
  replica.close()
  const data = chars ? [...cut.checkpoint.data, 'x'.repeat(chars)] : cut.checkpoint.data
  return makeBundle({ ...cut, checkpoint: { ...cut.checkpoint, data } }, { rebuilds: {} }, savedAt)
}
const sessionRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, cwd: '/tmp', program: 'shell', owner: { kind: 'human', id: 'h' }, generation: 1, inputSequence: 0, cols: 80, rows: 24, sizeEpoch: 0, sizeRevision: 0, state: 'completed', createdAt: 1, lastActivityAt: 1, ...extra }) as never
const text = (saved: Bundle | undefined) => saved?.cut.checkpoint.data.join('')

test('bundles (plan T35b): one per session, replaced whole, deleted with its history or its session', async () => {
  const store = new Store(':memory:')
  stores.push(store)
  store.save(sessionRow('a'))
  store.save(sessionRow('b'))
  expect(await store.saveBundle('a', await bundle('first'))).toEqual({ saved: true, evicted: [] })
  // The commit sets the session's flag with it.
  expect(store.session('a')?.outputSaved).toBe(true)
  await store.saveBundle('a', await bundle('second'))
  await store.saveBundle('b', await bundle('other'))
  expect(text(await store.bundle('a'))).toContain('second')
  expect(text(await store.bundle('a'))).not.toContain('first')
  expect((await store.bundle('a'))!.cut.tail).toHaveLength(1)
  store.deleteOutput('a')
  expect(await store.bundle('a')).toBeUndefined()
  store.deleteSession('b')
  expect(await store.bundle('b')).toBeUndefined()
  expect(store.bundleBytes()).toBe(0)
})
test('bundles fit their own limit: whole ones go, oldest first; one that cannot fit alone is not kept', async () => {
  const store = new Store(':memory:', 10 * 1024 * 1024, 250 * 1024 * 1024, 300_000)
  stores.push(store)
  for (const id of ['old', 'mid', 'new', 'huge']) store.save(sessionRow(id))
  await store.saveBundle('old', await bundle('old', 1, 120_000))
  await store.saveBundle('mid', await bundle('mid', 2, 120_000))
  // About 120 kB each (ASCII text, a byte a character): the third pushes the oldest out.
  expect(await store.saveBundle('new', await bundle('new', 3, 130_000))).toEqual({ saved: true, evicted: ['old'] })
  expect(await store.bundle('old')).toBeUndefined()
  // In the same commit: the evicted session says so.
  expect(store.session('old')).toMatchObject({ outputSaved: false, outputEvicted: true })
  expect(text(await store.bundle('mid'))).toContain('mid')
  expect(store.bundleBytes()).toBeLessThanOrEqual(300_000)
  // Larger than the whole limit: refused, and nothing else is removed for it.
  expect(await store.saveBundle('huge', await bundle('huge', 4, 400_000))).toEqual({ saved: false, evicted: [] })
  expect(await store.bundle('huge')).toBeUndefined()
  expect(store.session('huge')?.outputSaved).toBe(false)
  expect(text(await store.bundle('new'))).toContain('new')
})
test('bundle bytes are what SQLite stores: UTF-8 text and every part\'s metadata', async () => {
  const store = new Store(':memory:', 10 * 1024 * 1024, 250 * 1024 * 1024, 25_000)
  stores.push(store)
  store.save(sessionRow('wide'))
  // 10,000 three-byte characters: 30 kB stored, though only 10,000 JavaScript characters.
  const wide = await bundle('wide', 1)
  const result = await store.saveBundle('wide', { ...wide, cut: { ...wide.cut, checkpoint: { ...wide.cut.checkpoint, data: ['界'.repeat(10_000)] } } })
  expect(result.saved).toBe(false)
})
test('a bundle replaced or deleted while it is read is never returned incomplete', async () => {
  const store = new Store(':memory:')
  stores.push(store)
  store.save(sessionRow('moving'))
  await store.saveBundle('moving', await bundle('moving', 1, 8 * 1024 * 1024))
  const reading = store.bundle('moving')
  // At the read's first yield, the history is deleted.
  store.deleteOutput('moving')
  expect(await reading).toBeUndefined()
  const again = await bundle('again', 2, 8 * 1024 * 1024)
  const third = await bundle('third', 3, 9 * 1024 * 1024)
  await store.saveBundle('moving', again)
  const replaced = store.bundle('moving')
  await store.saveBundle('moving', third)
  // Replaced during the read: whichever it returns is whole (the one it began, or the replacement read again).
  const length = text(await replaced)!.length
  expect([text(again)!.length, text(third)!.length]).toContain(length)
})
test("the output flags are the store's once a session exists: a record read before a commit never writes them back", async () => {
  const store = new Store(':memory:')
  stores.push(store)
  store.save(sessionRow('owned', { state: 'exited', outputSaved: false }))
  const stale = store.session('owned')!
  await store.saveBundle('owned', await bundle('owned'))
  stale.lastActivityAt = 2
  store.save(stale)
  expect(store.session('owned')).toMatchObject({ lastActivityAt: 2, outputSaved: true })
  expect(stale.outputSaved).toBe(true)
})
test('a large bundle is written and read in slices: the event loop is never held long', async () => {
  const store = new Store(':memory:')
  stores.push(store)
  store.save(sessionRow('big'))
  // About 64 MB of checkpoint text (the documented worst case, 84M characters, is the same order).
  const big = await bundle('big', 1, 64 * 1024 * 1024)
  let worst = 0
  let last = performance.now()
  let probing = true
  const probe = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (probing) setImmediate(probe) }
  setImmediate(probe)
  expect((await store.saveBundle('big', big)).saved).toBe(true)
  const read = await store.bundle('big')
  // The probe's last turn measures the stretch up to now (a write that never yields is one long stretch).
  await new Promise((resolve) => setImmediate(resolve))
  probing = false
  expect(text(read)!.length).toBe(text(big)!.length)
  expect(worst).toBeLessThan(12)
})
test('on open: a rollback\'s deletions are reconciled and an interrupted write is dropped', async () => {
  const path = join(tmpdir(), `terminal-bundles-${crypto.randomUUID()}.db`)
  try {
    const first = new Store(path)
    for (const id of ['kept', 'gone', 'erased']) { first.save(sessionRow(id, { outputSaved: false })); await first.saveBundle(id, await bundle(id)) }
    first.close()
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const old = new Database(path)
    // What a rolled-back version does: it removes the session row and the history, never the bundle.
    old.query('DELETE FROM sessions WHERE id=?').run('gone')
    old.query('UPDATE sessions SET value=? WHERE id=?').run(JSON.stringify({ ...(sessionRow('erased') as object), historyDeleted: true }), 'erased')
    // A write that never committed: parts of a generation no bundle names.
    old.query("INSERT INTO bundle_parts VALUES ('kept', 99, 0, 'piece', NULL, 'orphan')").run()
    old.close()
    const reopened = new Store(path)
    stores.push(reopened)
    expect(text(await reopened.bundle('kept'))).toContain('kept')
    expect(await reopened.bundle('gone')).toBeUndefined()
    expect(await reopened.bundle('erased')).toBeUndefined()
    const leftover = new Database(path)
    expect(leftover.query("SELECT COUNT(*) AS n FROM bundle_parts WHERE generation=99").get()).toEqual({ n: 0 })
    expect(leftover.query("SELECT COUNT(*) AS n FROM bundle_parts WHERE session IN ('gone','erased')").get()).toEqual({ n: 0 })
    leftover.close()
    expect(reopened.session('kept')?.outputSaved).toBe(true)
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})
test('a bundle is never committed for a session deleted, or whose history was deleted, while it was written; flag changes move the revision', async () => {
  const store = new Store(':memory:')
  stores.push(store)
  for (const id of ['deleted', 'erased']) store.save(sessionRow(id))
  const pictures = [await bundle('deleted', 1, 4 * 1024 * 1024), await bundle('erased', 1, 4 * 1024 * 1024)]
  const deleted = store.saveBundle('deleted', pictures[0]!)
  const erased = store.saveBundle('erased', pictures[1]!)
  store.deleteSession('deleted')
  store.save({ ...store.session('erased')!, historyDeleted: true })
  expect((await deleted).saved).toBe(false)
  expect((await erased).saved).toBe(false)
  expect(store.hasBundle('deleted') || store.hasBundle('erased')).toBe(false)
  store.save(sessionRow('flagged'))
  const before = store.session('flagged')!.revision!
  await store.saveBundle('flagged', await bundle('flagged'))
  expect(store.session('flagged')!.revision).toBe(before + 1)
  store.markOutput('flagged', false)
  expect(store.session('flagged')!.revision).toBe(before + 2)
})
test('a generation is never used twice, even across deletion: a reader across a delete and a new bundle never mixes them', async () => {
  const store = new Store(':memory:')
  stores.push(store)
  store.save(sessionRow('reused'))
  const fresh = await bundle('new', 2, 8 * 1024 * 1024)
  await store.saveBundle('reused', await bundle('old', 1, 8 * 1024 * 1024))
  const reading = store.bundle('reused')
  store.deleteOutput('reused')
  await store.saveBundle('reused', fresh)
  const read = await reading
  // Whole: none, or the new one read again; never a mix of the two.
  if (read) expect(text(read)).toBe(text(fresh))
})
test('the generation counter starts above generations already stored (rows from before it existed)', async () => {
  const path = join(tmpdir(), `terminal-bundles-${crypto.randomUUID()}.db`)
  try {
    const first = new Store(path)
    first.save(sessionRow('older'))
    await first.saveBundle('older', await bundle('older'))
    first.close()
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const old = new Database(path)
    // As a database written before the counter: generations stored, the counter empty.
    old.exec('DELETE FROM bundle_generations; DELETE FROM sqlite_sequence')
    old.close()
    const reopened = new Store(path)
    stores.push(reopened)
    expect((await reopened.saveBundle('older', await bundle('newer'))).saved).toBe(true)
    expect(text(await reopened.bundle('older'))).toContain('newer')
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})
test('a stored bundle damaged on disk reads as none (an output event that lost its bytes)', async () => {
  const path = join(tmpdir(), `terminal-bundles-${crypto.randomUUID()}.db`)
  try {
    const first = new Store(path)
    first.save(sessionRow('damaged'))
    await first.saveBundle('damaged', await bundle('damaged'))
    first.close()
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const old = new Database(path)
    old.exec("UPDATE bundle_parts SET data = NULL WHERE kind = 'event'")
    old.close()
    const reopened = new Store(path)
    stores.push(reopened)
    expect(await reopened.bundle('damaged')).toBeUndefined()
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})
