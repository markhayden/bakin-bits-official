import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIRECTORY_LIMIT, listDirectories, recentDirectories } from '../lib/directories'
import type { Session } from '../lib/contracts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bakin-terminal-dirs-')))
afterAll(() => { chmodSync(join(root, 'locked'), 0o700); rmSync(root, { recursive: true, force: true }) })
for (const name of ['beta', 'Alpha', '.hidden', 'gamma', 'locked']) mkdirSync(join(root, name))
writeFileSync(join(root, 'a-file.txt'), 'not a folder')
symlinkSync(join(root, 'gamma'), join(root, 'linked'))
symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
chmodSync(join(root, 'locked'), 0o000)

describe('listDirectories (the New terminal folder picker)', () => {
  it('lists only folders (and links to folders), sorted without regard to case, hidden ones only when asked', async () => {
    const listed = await listDirectories(root)
    expect(listed.path).toBe(root)
    expect(listed.entries.map((entry) => entry.name)).toEqual(['Alpha', 'beta', 'gamma', 'linked', 'locked'])
    expect((await listDirectories(root, { hidden: true })).entries.map((entry) => entry.name)).toContain('.hidden')
    expect(listed.parent).toBe(join(root, '..').replace(/\/$/, '') === root ? undefined : realpathSync(join(root, '..')))
  })
  it('resolves the path it was given (a link, a trailing slash, ..) and defaults to home', async () => {
    expect((await listDirectories(join(root, 'linked/'))).path).toBe(join(root, 'gamma'))
    expect((await listDirectories(join(root, 'beta', '..'))).path).toBe(root)
    // No path: home (given here; a test harness's own home may not exist).
    expect((await listDirectories(undefined, { home: join(root, 'beta') })).path).toBe(join(root, 'beta'))
    expect((await listDirectories('  ', { home: join(root, 'beta') })).path).toBe(join(root, 'beta'))
    expect((await listDirectories('/')).parent).toBeUndefined()
  })
  it('refuses a relative path, a file, a missing folder and an unreadable one, by name', async () => {
    await expect(listDirectories('relative/path')).rejects.toThrow('must be absolute')
    await expect(listDirectories(join(root, 'a-file.txt'))).rejects.toThrow('is not a folder')
    await expect(listDirectories(join(root, 'missing'))).rejects.toThrow('does not exist')
    await expect(listDirectories(join(root, 'locked'))).rejects.toThrow('cannot be read')
  })
  it('is bounded: a huge folder lists the first DIRECTORY_LIMIT and says it was cut', async () => {
    const big = join(root, 'big')
    mkdirSync(big)
    for (let n = 0; n < DIRECTORY_LIMIT + 5; n++) mkdirSync(join(big, `d${String(n).padStart(4, '0')}`))
    const listed = await listDirectories(big)
    expect(listed.entries).toHaveLength(DIRECTORY_LIMIT)
    expect(listed.truncated).toBe('limit')
    // The filter runs before the cap: the last folder is still reachable.
    const last = `d${String(DIRECTORY_LIMIT + 4).padStart(4, '0')}`
    expect((await listDirectories(big, { filter: last })).entries.map((entry) => entry.name)).toEqual([last])
  })
  it('reads at most its scan budget of entries, and says the listing was cut', async () => {
    const listed = await listDirectories(join(root, 'big'), { scanLimit: 10 })
    expect(listed.entries.length).toBeLessThanOrEqual(10)
    expect(listed.truncated).toBe('scan')
  })
})

describe('recentDirectories', () => {
  const session = (cwd: string, createdAt: number, worktreePath?: string) => ({ cwd, createdAt, worktreePath }) as Session
  it('the newest sessions\' existing folders, once each, never a worktree, at most five', () => {
    const sessions = [
      session(join(root, 'beta'), 5), session(join(root, 'Alpha'), 4), session(join(root, 'beta'), 3),
      session(join(root, 'missing'), 6), session(join(root, 'gamma'), 7, join(root, 'gamma')),
      ...[1, 2, 0].map((n) => session(root, n)),
    ]
    expect(recentDirectories(sessions)).toEqual([join(root, 'beta'), join(root, 'Alpha'), root])
  })
})
