import { afterEach, expect, test } from 'bun:test'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { DAY, type Session } from '../lib/contracts'
import type { ProcessDriver } from '../lib/processes'

const managers: Sessions[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown() })
function fixture() {
  let now = 1000
  let enabled = [{ id: 'patch' }, { id: 'chef' }]
  const writes: string[] = []
  const live = new Set<string>()
  const attached = new Set<string>()
  const terminated: string[] = []
  let releasable = false
  const driver: ProcessDriver = {
    create: async (s) => { live.add(s.id) }, attach(s) { attached.add(s.id) }, connected: (id) => attached.has(id), write: (_id, data) => { writes.push(data) },
    resize: async () => {}, alive: async (id) => live.has(id), screen: async () => '',
    terminate: async (id) => { terminated.push(id); live.delete(id) }, inUse: async () => false, detach: async (id) => { if (id) attached.delete(id); else attached.clear() },
  }
  const manager = new Sessions(new Store(':memory:'), driver, {
    settings: () => ({ enabledAgents: enabled }), now: () => now,
    prepare: async () => ({ ok: false }), release: async () => releasable ? { ok: true } : { ok: false, error: 'Unmerged work' },
  })
  managers.push(manager)
  return { manager, writes, live, attached, terminated, allowRelease: () => { releasable = true }, disable: () => { enabled = [] }, advance: () => { now += 31 * DAY } }
}
const agent = { kind: 'agent', id: 'patch' } as const
const human = { kind: 'human', id: 'browser-123456789' } as const

test('queued takeover invalidates writes; viewing and reconnect do not return control', async () => {
  const { manager, writes } = fixture()
  const session = await manager.create({ title: 'Test', cwd: '/tmp' }, agent)
  await manager.write(session.id, agent, 1, 1, 'first')
  const takeover = manager.control(session.id, human, 'take')
  const stale = manager.write(session.id, agent, 1, 2, 'stale')
  await takeover
  await expect(stale).rejects.toThrow('ownership')
  expect(manager.list(agent)).toHaveLength(1)
  expect(manager.get(session.id, agent).owner).toEqual(human)
  expect(writes).toEqual(['first'])
  const returned = await manager.control(session.id, human, 'return')
  await manager.write(session.id, agent, returned.generation, 1, 'next')
  await expect(manager.write(session.id, agent, returned.generation, 1, 'duplicate')).rejects.toThrow('sequence')
})
test('reassignment and disabling revoke reads as well as writes', async () => {
  const { manager, disable } = fixture()
  const session = await manager.create({ title: 'Test', cwd: '/tmp' }, agent)
  await manager.control(session.id, human, 'assign', 'chef')
  expect(() => manager.output(session.id, agent, 0)).toThrow()
  expect(manager.list(agent)).toHaveLength(0)
  disable()
  expect(() => manager.list({ kind: 'agent', id: 'chef' })).toThrow()
  expect(manager.list(human)).toHaveLength(1)
})
test('completion refuses live processes; age expires output but preserves unmerged work', async () => {
  const { manager, advance } = fixture()
  const session = await manager.create({ title: 'Test', cwd: '/tmp' }, agent)
  await expect(manager.finish(session.id, agent, 1, false)).rejects.toThrow('running')
  session.worktreePath = '/tmp/retained'
  manager.store.save(session)
  manager.store.append(session.id, Buffer.from('retained output'))
  await manager.finish(session.id, agent, 1, true)
  expect(manager.get(session.id, human).cleanupReason).toBe('Unmerged work')
  advance()
  await manager.sweep()
  expect(manager.store.bytes()).toBe(0)
  expect(manager.get(session.id, human).worktreePath).toBe('/tmp/retained')
  await expect(manager.beforeUninstall(async () => {})).rejects.toThrow('retained')
})
test('failed launch remains visible and does not pretend a running process exists', async () => {
  const { manager } = fixture()
  await expect(manager.create({ title: 'Test', cwd: '/path-that-does-not-exist' }, human)).rejects.toThrow()
  expect(manager.list(human)).toHaveLength(0)
})
test('completion removes dead panes and does not extend retention on repeat', async () => {
  const { manager, live, terminated, advance } = fixture()
  const session = await manager.create({ title: 'Exited', cwd: '/tmp' }, human)
  live.delete(session.id)
  const completed = await manager.finish(session.id, human, 1, false)
  expect(terminated).toEqual([session.id])
  advance()
  expect((await manager.finish(session.id, human, 1, false)).completedAt).toBe(completed.completedAt)
  expect(terminated).toHaveLength(1)
})
test('disconnected output fails honestly and a snapshot restores the attachment', async () => {
  const { manager, attached } = fixture()
  const session = await manager.create({ title: 'Reconnect', cwd: '/tmp' }, human)
  attached.delete(session.id)
  expect(() => manager.output(session.id, human, 0)).toThrow('reconnect')
  await manager.screen(session.id, human)
  expect(attached.has(session.id)).toBe(true)
})
test('delete removes a completed session entirely and only for the human', async () => {
  const { manager, live, allowRelease } = fixture()
  const session = await manager.create({ title: 'Done', cwd: '/tmp' }, agent)
  await expect(manager.deleteSession(session.id, human)).rejects.toThrow('End the session')
  session.worktreePath = '/tmp/retained'
  manager.store.save(session)
  live.delete(session.id)
  await manager.finish(session.id, agent, 1, false)
  await expect(manager.deleteSession(session.id, human)).rejects.toThrow('retained worktree')
  allowRelease()
  await manager.sweep()
  manager.store.append(session.id, Buffer.from('history'))
  await expect(manager.deleteSession(session.id, agent)).rejects.toThrow('human')
  await manager.deleteSession(session.id, human)
  expect(manager.list(human)).toHaveLength(0)
  expect(manager.store.bytes()).toBe(0)
  expect(() => manager.get(session.id, human)).toThrow('not found')
  await manager.beforeUninstall(async () => {})
})
test('an exited session deletes without a completion step; any human tab can drive', async () => {
  const { manager, live } = fixture()
  // A second human client — a different browser tab or the phone.
  const otherHuman = { kind: 'human', id: 'phone-000000000000' } as const
  const session = await manager.create({ title: 'Ended', cwd: '/tmp' }, human)
  // The operator's other tab drives the human-owned session without taking over.
  await manager.write(session.id, otherHuman, session.generation, 1, 'ls\r')
  live.delete(session.id)
  await manager.refreshStates()
  expect(manager.get(session.id, human).state).toBe('exited')
  // Deletable straight from exited — no "complete" step, from either tab.
  await manager.deleteSession(session.id, otherHuman)
  expect(manager.list(human)).toHaveLength(0)
})
test('completed work is rechecked immediately after merge without a 30-day delay', async () => {
  const { manager, allowRelease } = fixture()
  const session = await manager.create({ title: 'Merged', cwd: '/tmp' }, human)
  session.worktreePath = '/tmp/retained'
  manager.store.save(session)
  await manager.finish(session.id, human, 1, true)
  expect(manager.get(session.id, human).worktreePath).toBeDefined()
  allowRelease()
  await manager.sweep()
  expect(manager.get(session.id, human).worktreePath).toBeUndefined()
})
