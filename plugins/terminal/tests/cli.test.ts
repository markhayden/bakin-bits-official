import { describe, expect, it } from 'bun:test'
import { newBody, newSessionInput, operator, resolveRef, sessionTable } from '../lib/cli'
import { attachCommand, shortId, type Session } from '../lib/contracts'

function session(id: string, title: string, overrides: Partial<Session> = {}): Session {
  return {
    id: `terminal-${id}`, title, cwd: '/Users/me/code/bakin', program: 'shell', owner: { kind: 'human', id: 'x' },
    generation: 1, inputSequence: 0, cols: 200, rows: 60, sizeEpoch: 0, sizeRevision: 0, state: 'running', createdAt: 0, lastActivityAt: 0,
    ...overrides,
  }
}

const a = session('1a2b3c4d-0000-4000-8000-000000000001', 'bakin')
const b = session('1a2b3c4d-9999-4000-8000-000000000002', 'tests')
const c = session('7f00aa11-0000-4000-8000-000000000003', 'bakin', { state: 'completed' })

describe('resolveRef', () => {
  it('takes a full id, a unique prefix of at least 8 characters, or an exact title of a running session', () => {
    expect(resolveRef([a, b, c], c.id)).toBe(c)
    expect(resolveRef([a, b], '1a2b3c4d-0')).toBe(a)
    expect(resolveRef([a, b], 'terminal-1a2b3c4d-9')).toBe(b)
    expect(resolveRef([a, b, c], 'bakin')).toBe(a)
  })

  it('lists the candidates when a prefix or title is ambiguous, and refuses short prefixes', () => {
    expect(() => resolveRef([a, b], '1a2b3c4d')).toThrow(`Several sessions match "1a2b3c4d"; use an id:\n  ${a.id}  bakin\n  ${b.id}  tests`)
    expect(() => resolveRef([a, b], '1a2b')).toThrow('No running session matches "1a2b"')
  })
})

describe('bakin terminal new', () => {
  const body = (params: Record<string, unknown>) => newBody.parse({ params, caller: { cwd: '/Users/me/code/bakin', cols: 120, rows: 40 } })

  it('defaults to a shell in the caller\'s directory on the existing checkout, titled after it', () => {
    expect(newSessionInput(body({}))).toEqual({ title: 'bakin', cwd: '/Users/me/code/bakin', program: 'shell', checkout: 'existing' })
  })

  it('--worktree isolates any program, and --agent only assigns', () => {
    expect(newSessionInput(body({ worktree: true, agent: 'patch', title: 'Fix' }))).toEqual({ title: 'Fix', cwd: '/Users/me/code/bakin', program: 'shell', checkout: 'isolated', agentId: 'patch' })
  })

  it('rejects arguments the command does not declare', () => {
    expect(() => body({ detach: true })).toThrow()
  })
})

describe('operator', () => {
  const request = (headers: Record<string, string>) => new Request('http://bakin/api/plugins/terminal/cli/attach', { method: 'POST', headers })

  it('admits the declared operator and refuses agents and undeclared callers', () => {
    expect(operator(request({ 'x-bakin-operator': 'declared' }))).toEqual({ kind: 'human', id: 'cli' })
    expect(() => operator(request({ 'x-bakin-operator': 'declared', 'x-bakin-agent-context': 'patch' }))).toThrow('agent context')
    expect(() => operator(request({}))).toThrow('--as human')
  })
})

describe('sessionTable', () => {
  it('prints one aligned row per session with its terminal app count', () => {
    const table = sessionTable([a, { ...c, owner: { kind: 'agent', id: 'patch' }, worktreePath: '/w', cwd: '/w' }], (id) => id === a.id ? [{ pid: 1, name: 't', cols: 1, rows: 1, readonly: false }] : [], '/Users/me')
    expect(table.split('\n')).toEqual([
      'ID        TITLE  PROGRAM  OWNER  STATE      SIZE    DIRECTORY      APPS',
      '1a2b3c4d  bakin  shell    you    running    200×60  ~/code/bakin   1',
      '7f00aa11  bakin  shell    patch  completed  200×60  /w (worktree)  0',
    ])
    expect(shortId(a)).toBe('1a2b3c4d')
    expect(attachCommand(a)).toBe(`bakin terminal attach ${a.id} --as human`)
  })

  it('says how to start when there are none', () => {
    expect(sessionTable([], () => [])).toContain('bakin terminal new')
  })
})
