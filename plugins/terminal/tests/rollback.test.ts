import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBundle } from '../lib/bundle'
import { Replica } from '../lib/replica'
import { Store } from '../lib/store'

// Plan T35b rollback contract: B5 (the release before the raw path; 65604c7, the one installed when
// this was written) and this version share one terminal.db, back and forth. B5's own store code is
// read from git, so the test is skipped where that commit is not available (a shallow clone).
const B5 = '65604c7'
const dir = mkdtempSync(join(tmpdir(), 'terminal-rollback-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const source = Bun.spawnSync(['git', 'show', `${B5}:plugins/terminal/lib/store.ts`], { cwd: import.meta.dir })
const rollbackTest = source.exitCode === 0 ? test : test.skip

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, cwd: '/tmp', program: 'shell', owner: { kind: 'human', id: 'h' }, generation: 1, inputSequence: 0, cols: 80, rows: 24, sizeEpoch: 0, sizeRevision: 0, state: 'completed', createdAt: 1, lastActivityAt: 1, outputSaved: false, ...extra }) as never
async function picture(text: string) {
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode(`\x1bc${text}`), cols: 80, rows: 24, reason: 'test', history: true })
  await replica.event({ seq: 2, kind: 'layout', cols: 100, rows: 24 })
  const cut = replica.cut()!
  replica.close()
  return makeBundle(cut, { rebuilds: {} }, 1)
}

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
  for (const id of ['kept', 'gone', 'erased', 'expired']) { current.save(row(id)); current.append(id, Buffer.from(`${id} output`)); await current.saveBundle(id, await picture(id)) }
  current.close()
  // Rolled back: B5 reads every session's legacy output, and deletes without knowing bundles.
  const rolled = new B5Store(path)
  for (const id of ['legacy', 'kept', 'gone']) expect(rolled.output(id, 0).data.toString()).toBe(`${id} output`)
  expect(rolled.sessions().map((session) => session.id).sort()).toEqual(['erased', 'expired', 'gone', 'kept', 'legacy'])
  rolled.deleteSession('gone')
  // History deleted (by the operator, and by retention: both are deleteOutput + historyDeleted).
  for (const id of ['erased', 'expired']) { rolled.deleteOutput(id); rolled.save({ ...rolled.sessions().find((session) => session.id === id)!, historyDeleted: true }) }
  rolled.close()
  // Upgraded again: the deletions are reconciled, the rest is intact.
  const upgraded = new Store(path)
  expect((await upgraded.bundle('kept'))?.cut.checkpoint.data.join('')).toContain('kept')
  expect(upgraded.session('kept')?.outputSaved).toBe(true)
  for (const id of ['gone', 'erased', 'expired']) expect(await upgraded.bundle(id)).toBeUndefined()
  expect(upgraded.output('legacy', 0).data.toString()).toBe('legacy output')
  upgraded.close()
  // And back once more: B5 opens a database holding bundles without trouble.
  const again = new B5Store(path)
  expect(again.output('kept', 0).data.toString()).toBe('kept output')
  again.close()
  const last = new Store(path)
  expect((await last.bundle('kept'))?.cols).toBe(100)
  last.close()
})
