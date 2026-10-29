import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBundle } from '../lib/bundle'
import { Replica } from '../lib/replica'
import { Store } from '../lib/store'
import headless from '@xterm/headless'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'

// Plan T35b rollback contract: B5 (the release before the raw path; 65604c7, the one installed when
// this was written) and this version share one terminal.db, back and forth. B5's own store code is
// read from git, so the test is skipped where that commit is not available (a shallow clone).
const B5 = '65604c7'
const dir = mkdtempSync(join(tmpdir(), 'terminal-rollback-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const source = Bun.spawnSync(['git', 'show', `${B5}:plugins/terminal/lib/store.ts`], { cwd: import.meta.dir })
const rollbackTest = source.exitCode === 0 ? test : test.skip

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, cwd: '/tmp', program: 'shell', owner: { kind: 'human', id: 'h' }, generation: 1, inputSequence: 0, cols: 80, rows: 24, sizeEpoch: 0, sizeRevision: 0, state: 'completed', createdAt: 1, lastActivityAt: 1, outputSaved: false, ...extra }) as never
/** A picture with output, a resize and a width change's geometry after its base: what a replay must keep. */
async function picture(text: string) {
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  const encode = (value: string) => new TextEncoder().encode(value)
  await replica.event({ seq: 1, kind: 'seed', bytes: encode(`\x1bc${text}`), cols: 80, rows: 24, reason: 'test', history: true })
  await replica.event({ seq: 2, kind: 'output', offset: 0, bytes: encode(' after the base') })
  await replica.event({ seq: 3, kind: 'layout', cols: 100, rows: 24 })
  await replica.event({ seq: 4, kind: 'geometry', bytes: encode(`\x1bc${text} reflowed`), cols: 100, rows: 24, generation: 1, history: true })
  const cut = replica.cut()!
  replica.close()
  return makeBundle(cut, { rebuilds: { overload: 1 } }, 1)
}
/** A bundle replayed as a viewer does (checkpoint, then the tail in order), as the text it shows. */
async function replayed(bundle: Awaited<ReturnType<typeof picture>> | undefined): Promise<string> {
  const { checkpoint, tail } = bundle!.cut
  const term = new headless.Terminal({ cols: checkpoint.cols, rows: checkpoint.rows, ...TERMINAL_OPTIONS, scrollback: checkpoint.scrollback })
  applyTerminalProfile(term).setLive(false)
  const write = (data: string | Uint8Array) => new Promise<void>((resolve) => term.write(data, resolve))
  for (const piece of checkpoint.data) await write(piece)
  for (const event of tail) {
    if (event.kind === 'output') await write(event.bytes)
    if (event.kind === 'layout') term.resize(event.cols, event.rows)
    if (event.kind === 'geometry') { term.resize(event.cols, event.rows); await write(event.bytes) }
  }
  let text = ''
  for (let y = 0; y < term.buffer.active.length; y++) text += term.buffer.active.getLine(y)!.translateToString(true) + '\n'
  term.dispose()
  return `${term.cols}x${term.rows}\n${text}`
}
/** Equal as pictures (the checkpoint's text may come back in other pieces). */
const comparable = (bundle: Awaited<ReturnType<typeof picture>> | undefined) => bundle && ({ ...bundle, cut: { ...bundle.cut, checkpoint: { ...bundle.cut.checkpoint, data: [bundle.cut.checkpoint.data.join('')] } } })

rollbackTest('B5 → this version → B5 → this version: legacy output stays readable, and what B5 deleted is reconciled', async () => {
  writeFileSync(join(dir, 'b5-store.ts'), source.stdout)
  writeFileSync(join(dir, 'contracts.ts'), 'export {}\n')
  const { Store: B5Store } = await import(join(dir, 'b5-store.ts')) as { Store: typeof Store }
  const path = join(dir, 'terminal.db')
  // B5 first: sessions with legacy output only.
  const b5 = new B5Store(path)
  b5.save(row('legacy', { outputSaved: undefined }))
  b5.append('legacy', Buffer.from('legacy output'))
  b5.close()
  // This version: each session ends with a bundle beside its legacy output (the bridge writes both until T38b).
  const current = new Store(path)
  const pictures: Record<string, Awaited<ReturnType<typeof picture>>> = {}
  for (const id of ['kept', 'gone', 'erased', 'expired']) { current.save(row(id)); current.append(id, Buffer.from(`${id} output`)); await current.saveBundle(id, pictures[id] = await picture(id)) }
  // Created here, still running at the rollback: one B5 then ends; one this version saved, then crashed before the kill.
  current.save(row('ended-under-b5', { state: 'running' }))
  current.save(row('provisional', { state: 'running' }))
  await current.saveBundle('provisional', await picture('provisional'))
  // A write interrupted before its commit (staged parts of a generation no bundle names).
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  current.close()
  const crash = new Database(path)
  crash.query("INSERT INTO bundle_parts VALUES ('kept', 999999, 0, 'piece', NULL, 'half a write')").run()
  crash.close()
  // Rolled back: B5 reads every session's legacy output, and deletes without knowing bundles.
  const rolled = new B5Store(path)
  for (const id of ['legacy', 'kept', 'gone']) expect(rolled.output(id, 0).data.toString()).toBe(`${id} output`)
  expect(rolled.sessions().map((session) => session.id).sort()).toEqual(['ended-under-b5', 'erased', 'expired', 'gone', 'kept', 'legacy', 'provisional'])
  rolled.deleteSession('gone')
  // B5's own lifecycle writes (boot, input, completion): it ends both running sessions, the second after more output.
  for (const id of ['ended-under-b5', 'provisional']) {
    rolled.append(id, Buffer.from(`${id} under B5`))
    rolled.save({ ...rolled.sessions().find((session) => session.id === id)!, state: 'completed', completedAt: 2 })
  }
  // History deleted (by the operator, and by retention: both are deleteOutput + historyDeleted).
  for (const id of ['erased', 'expired']) { rolled.deleteOutput(id); rolled.save({ ...rolled.sessions().find((session) => session.id === id)!, historyDeleted: true }) }
  rolled.close()
  // Upgraded again: the deletions are reconciled, the rest is intact.
  const upgraded = new Store(path)
  // Untouched while rolled back: the same picture, field for field and replayed event for event.
  expect(comparable(await upgraded.bundle('kept'))).toEqual(comparable(pictures.kept))
  expect(await replayed(await upgraded.bundle('kept'))).toBe(await replayed(pictures.kept))
  expect(await replayed(pictures.kept)).toContain('kept reflowed')
  expect(upgraded.session('kept')?.outputSaved).toBe(true)
  // Written by B5 since: their final output is B5's, the legacy output (no bundle, no flags).
  for (const id of ['ended-under-b5', 'provisional']) {
    expect(await upgraded.bundle(id)).toBeUndefined()
    expect(upgraded.session(id)).not.toHaveProperty('outputSaved')
    expect(upgraded.output(id, 0).data.toString()).toBe(`${id} under B5`)
  }
  // The interrupted write is gone; the committed bundle beside it is intact.
  const left = new Database(path)
  expect(left.query('SELECT COUNT(*) AS n FROM bundle_parts WHERE generation = 999999').get()).toEqual({ n: 0 })
  left.close()
  for (const id of ['gone', 'erased', 'expired']) expect(await upgraded.bundle(id)).toBeUndefined()
  expect(upgraded.output('legacy', 0).data.toString()).toBe('legacy output')
  upgraded.close()
  // And back once more: B5 opens a database holding bundles without trouble.
  const again = new B5Store(path)
  expect(again.output('kept', 0).data.toString()).toBe('kept output')
  again.close()
  const last = new Store(path)
  expect(comparable(await last.bundle('kept'))).toEqual(comparable(pictures.kept))
  last.close()
})

rollbackTest('a failed save survives a restart: the session still says not saved, with no bundle', async () => {
  const path = join(dir, 'failed.db')
  const first = new Store(path)
  first.save(row('failed'))
  first.markOutput('failed', false)
  first.close()
  const reopened = new Store(path)
  expect(reopened.session('failed')?.outputSaved).toBe(false)
  expect(await reopened.bundle('failed')).toBeUndefined()
  reopened.close()
})
