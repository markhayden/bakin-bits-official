import { afterEach, describe, expect, it, test } from 'bun:test'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { DAY, TerminalError, type Session } from '../lib/contracts'
import type { NativeClient, ProcessDriver } from '../lib/processes'
import { MAX_BACKLOG_BYTES, Replica, type Cut } from '../lib/replica'
import { OutputLog } from '../lib/output-log'
import { drainFinal } from '../lib/processes'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBundle } from '../lib/bundle'

const managers: Sessions[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown() })
function fixture(options: { storePath?: string } = {}) {
  let now = 1000
  let enabled = [{ id: 'patch' }, { id: 'chef' }]
  const writes: string[] = []
  const live = new Set<string>()
  const attached = new Set<string>()
  const terminated: string[] = []
  const forgotten: string[] = []
  /** Sessions whose control client closed; every attach, in order. */
  const controlLost = new Set<string>()
  const attaches: string[] = []
  /** Each final picture asked for, in order with terminations; what the next one gives (a cut, none, or a throw). */
  const finals: string[] = []
  const finalCut: { next: () => Promise<Cut | undefined> } = { next: async () => undefined }
  /** Each session's pane-died hint, as the driver gives it. */
  const paneDied = new Map<string, () => void>()
  let releasable = false
  let writeFailure: Error | undefined
  let resizeFailure: Error | undefined
  let readBackFailure: Error | undefined
  const tmuxSizes = new Map<string, { cols: number; rows: number }>()
  /** Terminal apps attached in tmux, per session, and each session's "clients changed" signal. */
  const natives = new Map<string, NativeClient[]>()
  const clientsChanged = new Map<string, () => void>()
  const vanishing = new Set<number>()
  const detachedClients: string[] = []
  /** Replicas, by session (none until a test makes one). */
  const replicas = new Map<string, Replica>()
  /** Sessions whose kill fails (the program runs on). */
  const unkillable = new Set<string>()
  /** While set, tmux's new-session waits on it (a creation held in the manager's queue). */
  const createHold: { until?: Promise<void> } = {}
  const driver: ProcessDriver = {
    // Like TmuxProcesses.replica: an ended replica is no source.
    replica: (id) => { const replica = replicas.get(id); return replica?.ended ? undefined : replica },
    create: async (s) => { await createHold.until; live.add(s.id); tmuxSizes.set(s.id, { cols: s.cols, rows: s.rows }) }, attach(s, changed, died) { attaches.push(s.id); controlLost.delete(s.id); attached.add(s.id); clientsChanged.set(s.id, changed); if (died) paneDied.set(s.id, died) }, connected: (id) => attached.has(id) && !controlLost.has(id),
    write: async (_id, data) => { if (writeFailure) throw writeFailure; writes.push(data) },
    resize: async (id, cols, rows) => { if (resizeFailure) { tmuxSizes.set(id, { cols: 77, rows: 22 }); throw resizeFailure } tmuxSizes.set(id, { cols, rows }) },
    windowSize: async (id) => { if (readBackFailure) throw readBackFailure; return tmuxSizes.get(id)! },
    title: async () => {}, alive: async (id) => live.has(id),
    terminate: async (id) => { if (unkillable.has(id)) throw new Error('kill-session failed'); terminated.push(id); finals.push(`terminate ${id}`); live.delete(id) },
    finalCut: async (id, options) => { finals.push(`final ${id} boundary=${options.boundary}`); return finalCut.next() }, inUse: async () => false, detach: async (id) => { if (id) attached.delete(id); else attached.clear() },
    // Like tmux: a client in `vanishing` is listed once, then gone before anyone acts on it.
    clients: async (id) => {
      const listed = natives.get(id) ?? []
      natives.set(id, listed.filter((client) => !vanishing.has(client.pid)))
      return listed
    },
    detachClient: async (name) => {
      if (![...natives.values()].flat().some((client) => client.name === name)) throw new Error(`can't find client: ${name}`)
      detachedClients.push(name)
      for (const [id, list] of natives) natives.set(id, list.filter((client) => client.name !== name))
    },
    setReadonly: async (id, target, readonly) => {
      if (!(natives.get(id) ?? []).some((client) => client.name === target.name)) throw new Error(`can't find client: ${target.name}`)
      natives.set(id, (natives.get(id) ?? []).map((client) => client.name === target.name ? { ...client, readonly } : client))
    },
    attachArgs: (id) => ['-S', '/tmp/t.sock', 'attach-session', '-t', id],
    forget: (id) => { forgotten.push(id) },
  }
  const releases: Array<{ sessionId: string; worktreePath: string; teardown?: boolean }> = []
  const store = new Store(options.storePath ?? ':memory:')
  const manager = new Sessions(store, driver, {
    settings: () => ({ enabledAgents: enabled }), now: () => now,
    prepare: async () => ({ ok: false }),
    release: async (input) => { releases.push(input); return releasable ? { ok: true } : { ok: false, error: 'Unmerged work' } },
  })
  managers.push(manager)
  return {
    manager, store, writes, live, attached, terminated, unkillable, createHold, forgotten, controlLost, attaches, finals, finalCut, paneDied, releases, natives, detachedClients, vanishing, replicas,
    /** A terminal app attaches (or resizes) in tmux; the control client notices. */
    nativeAttach: async (id: string, client: NativeClient) => {
      natives.set(id, [...(natives.get(id) ?? []).filter((entry) => entry.pid !== client.pid), client])
      clientsChanged.get(id)?.()
      await manager.idle()
    },
    nativeLeave: async (id: string, pid: number) => {
      natives.set(id, (natives.get(id) ?? []).filter((entry) => entry.pid !== pid))
      clientsChanged.get(id)?.()
      await manager.idle()
    },
    later: (ms: number) => { now += ms },
    failWrites: (error: Error) => { writeFailure = error },
    failResizes: (error: Error | undefined) => { resizeFailure = error },
    failReadBack: (error: Error | undefined) => { readBackFailure = error },
    tmuxSizes,
    allowRelease: () => { releasable = true }, disable: () => { enabled = [] }, advance: () => { now += 31 * DAY },
  }
}
/** An ended session's saved picture with `text` on its screen. */
async function picture(text: string) {
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode(`\x1bc${text}`), cols: 80, rows: 24, reason: 'test', history: true })
  const cut = replica.cut()!
  replica.close()
  return makeBundle(cut, { rebuilds: {} }, 1)
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
  await expect(manager.outputText(session.id, agent)).rejects.toThrow('not available to this agent')
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
  await manager.store.saveBundle(session.id, await picture('retained output'))
  await manager.finish(session.id, agent, 1, true)
  expect(manager.get(session.id, human).cleanupReason).toBe('Unmerged work')
  advance()
  await manager.sweep()
  expect(manager.store.hasBundle(session.id)).toBe(false)
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
test('a read of a disconnected session attaches it again first', async () => {
  const { manager, attached, replicas } = fixture()
  const session = await manager.create({ title: 'Reconnect', cwd: '/tmp' }, human)
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bcback'), cols: 80, rows: 24, reason: 'test', history: true })
  replicas.set(session.id, replica)
  attached.delete(session.id)
  expect((await manager.outputText(session.id, human)).text).toBe('back')
  expect(attached.has(session.id)).toBe(true)
  replica.close()
})
test('outputText (the agent tool\'s output): history then screen as lines, the last `lines` when asked; an ended session\'s from its saved picture', async () => {
  const { manager, replicas, live } = fixture()
  const session = await manager.create({ title: 'Text', cwd: '/tmp' }, agent)
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bcone\r\ntwo\r\nthree'), cols: 80, rows: 24, reason: 'test', history: true })
  replicas.set(session.id, replica)
  expect(await manager.outputText(session.id, agent)).toMatchObject({ text: 'one\ntwo\nthree', lines: 3, truncated: false })
  expect(await manager.outputText(session.id, agent, 2)).toMatchObject({ text: 'two\nthree', lines: 2, truncated: true })
  replica.close()
  // Ended: its bundle, or why there is none.
  live.delete(session.id)
  await manager.refreshStates()
  manager.store.markOutput(session.id, false)
  await expect(manager.outputText(session.id, agent)).rejects.toThrow('without its output being saved')
  await manager.store.saveBundle(session.id, await picture('final words'))
  expect((await manager.outputText(session.id, agent)).text).toBe('final words')
})
test('a reassignment while a read waits revokes it: access is checked again when the read runs', async () => {
  const { manager, replicas } = fixture()
  const session = await manager.create({ title: 'Revoked', cwd: '/tmp' }, agent)
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bcsecret'), cols: 80, rows: 24, reason: 'test', history: true })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = 0
  const read = replica.read.bind(replica)
  replica.read = (async (fn: Parameters<typeof read>[0]) => { waiting++; await gate; return read(fn) }) as typeof replica.read
  replicas.set(session.id, replica)
  const screen = manager.readScreen(session.id, agent)
  const text = manager.outputText(session.id, agent)
  for (let n = 0; n < 50 && waiting < 2; n++) await Bun.sleep(2)
  expect(waiting).toBe(2)
  await manager.control(session.id, human, 'assign', 'chef')
  release()
  const results = await Promise.allSettled([screen, text])
  expect(results.map((result) => result.status === 'rejected' && String(result.reason))).toEqual(['Error: Session not available to this agent', 'Error: Session not available to this agent'])
  replica.close()
})
test('a natural exit registers its final save with the exit: a viewer joining while the refresh still checks another session waits for it', async () => {
  const { manager, live, finalCut } = fixture()
  const first = await manager.create({ title: 'First', cwd: '/tmp' }, human)
  const second = await manager.create({ title: 'Second', cwd: '/tmp' }, human)
  let releaseSave!: () => void
  finalCut.next = () => new Promise((resolve) => { releaseSave = () => resolve(undefined) })
  // The refresh publishes the first exit, then waits on the second's liveness check.
  let releaseCheck!: () => void
  const check = new Promise<void>((resolve) => { releaseCheck = resolve })
  const alive = manager['driver'].alive.bind(manager['driver'])
  manager['driver'].alive = async (id: string) => { if (id === second.id) await check; return alive(id) }
  live.delete(first.id)
  const refresh = manager.refreshStates()
  for (let n = 0; n < 50 && manager.get(first.id, human).state !== 'exited'; n++) await Bun.sleep(2)
  expect(manager.get(first.id, human).state).toBe('exited')
  let settled = false
  const saved = manager.finalSaved(first.id).then(() => { settled = true })
  await Bun.sleep(20)
  expect(settled).toBe(false)
  releaseCheck()
  releaseSave()
  await saved
  await refresh
  expect(manager.get(first.id, human).outputSaved).toBe(false)
})
test('setup finds a session that exited while nothing watched (a restart): it attaches to the retained pane first, and its save is registered with the exit', async () => {
  const { manager, live, finalCut, attaches, finals } = fixture()
  const session = await manager.create({ title: 'Restarted', cwd: '/tmp' }, human)
  // As after a restart: nothing attached, and the program has exited meanwhile.
  ;(manager as unknown as { attached: Set<string> }).attached.clear()
  live.delete(session.id)
  let releaseSave!: () => void
  finalCut.next = () => new Promise((resolve) => { releaseSave = () => resolve(undefined) })
  const setup = manager.setupService(async () => {})
  for (let n = 0; n < 50 && !finals.some((entry) => entry.startsWith(`final ${session.id}`)); n++) await Bun.sleep(2)
  expect(attaches.filter((id) => id === session.id)).toHaveLength(2)
  expect(manager.get(session.id, human).state).toBe('exited')
  let settled = false
  void manager.finalSaved(session.id).then(() => { settled = true })
  await Bun.sleep(20)
  expect(settled).toBe(false)
  releaseSave()
  await setup
  expect(settled).toBe(true)
})
test('a sweep retry replaces an unusable attachment (its control client connected, its replica ended) before saving', async () => {
  const { manager, live, replicas, attaches, finals, store, attached } = fixture()
  const session = await manager.create({ title: 'Overflowed', cwd: '/tmp' }, human)
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  replicas.set(session.id, replica)
  live.delete(session.id)
  await manager.refreshStates()
  store.markOutput(session.id, false)
  // The replica ended (a log overflow) while the control client stayed connected.
  replica.close()
  expect(attached.has(session.id)).toBe(true)
  const before = attaches.length
  finals.length = 0
  await manager.sweep()
  expect(attaches.length).toBe(before + 1)
  expect(finals[0]).toStartWith(`final ${session.id}`)
})
test('a sweep started while a save is in flight waits for it; when it fails, the retry saves from a replaced attachment before maintenance completes the session', async () => {
  const { manager, live, finalCut, finals, terminated, advance, store, attaches } = fixture()
  const session = await manager.create({ title: 'Overlap', cwd: '/tmp' }, human)
  const source = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await source.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bclast words'), cols: 80, rows: 24, reason: 'test', history: true })
  const cut = source.cut()!
  source.close()
  let failFirst!: () => void
  const cuts: Array<() => Promise<Cut | undefined>> = [
    () => new Promise((resolve) => { failFirst = () => resolve(undefined) }),
    async () => cut,
  ]
  finalCut.next = () => cuts.shift()!()
  live.delete(session.id)
  const refresh = manager.refreshStates()
  for (let n = 0; n < 50 && !failFirst; n++) await Bun.sleep(2)
  advance()
  const before = attaches.length
  const sweep = manager.sweep()
  await Bun.sleep(20)
  // Nothing was decided while the first save ran.
  expect(terminated).toEqual([])
  expect(attaches.length).toBe(before)
  failFirst()
  await refresh
  await sweep
  expect(finals.filter((entry) => entry.startsWith('final'))).toHaveLength(2)
  expect(store.session(session.id)?.outputSaved).toBe(true)
  expect(terminated).toEqual([session.id])
  expect(finals.at(-1)).toBe(`terminate ${session.id}`)
})
test('a maintenance pass that did not retry an unsaved session leaves it for one that does', async () => {
  const { manager, live, terminated, advance, store } = fixture()
  const session = await manager.create({ title: 'Unsaved', cwd: '/tmp' }, human)
  live.delete(session.id)
  await manager.refreshStates()
  store.markOutput(session.id, false)
  advance()
  await manager['run'](() => manager['sweepUnlocked'](), true)
  expect(terminated).toEqual([])
  await manager.sweep()
  expect(terminated).toEqual([session.id])
})
test('sweep reserves every retried save before waiting on any: a later one is never completed (its pane killed) while an earlier one saves', async () => {
  const { manager, live, finalCut, terminated, store, advance } = fixture()
  const first = await manager.create({ title: 'First', cwd: '/tmp' }, human)
  const second = await manager.create({ title: 'Second', cwd: '/tmp' }, human)
  for (const id of [first.id, second.id]) live.delete(id)
  await manager.refreshStates()
  for (const id of [first.id, second.id]) store.markOutput(id, false)
  advance()
  const releases: Array<() => void> = []
  finalCut.next = () => new Promise((resolve) => { releases.push(() => resolve(undefined)) })
  const sweep = manager.sweep()
  for (let n = 0; n < 50 && releases.length === 0; n++) await Bun.sleep(2)
  let settled = false
  void manager.finalSaved(second.id).then(() => { settled = true })
  await Bun.sleep(20)
  expect(settled).toBe(false)
  // Maintenance run meanwhile (a creation's) leaves both reserved sessions alone.
  await manager['run'](() => manager['sweepUnlocked'](), true)
  expect(terminated).toEqual([])
  for (let n = 0; n < 50 && releases.length < 2; n++) { for (const release of releases.splice(0)) release(); await Bun.sleep(2) }
  for (const release of releases.splice(0)) release()
  await sweep
  expect(terminated.sort()).toEqual([first.id, second.id].sort())
})
test('delete always removes the session — a retained worktree tears down, never blocks', async () => {
  const { manager, live, releases, forgotten } = fixture()
  const session = await manager.create({ title: 'Done', cwd: '/tmp' }, agent)
  await expect(manager.deleteSession(session.id, human)).rejects.toThrow('End the session')
  session.worktreePath = '/tmp/retained'
  manager.store.save(session)
  live.delete(session.id)
  await manager.finish(session.id, agent, 1, false)
  await manager.store.saveBundle(session.id, await picture('history'))
  await expect(manager.deleteSession(session.id, agent)).rejects.toThrow('human')
  // The fixture release fails ("Unmerged work"), yet the session is gone: the
  // worktree teardown is best-effort and never blocks removing the record.
  // Ending it kept what the driver holds for it (its fidelity); deleting it forgets that.
  expect(forgotten).toEqual([])
  await manager.deleteSession(session.id, human)
  expect(forgotten).toEqual([session.id])
  // The safe clean at finish ran without teardown; the delete forces it.
  expect(releases.at(-1)).toEqual({ sessionId: session.id, worktreePath: '/tmp/retained', teardown: true })
  expect(releases.some((r) => !r.teardown)).toBe(true)
  expect(manager.list(human)).toHaveLength(0)
  expect(manager.store.hasBundle(session.id)).toBe(false)
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

test('a failed delivery surfaces and still consumes the sequence (never retried)', async () => {
  const { manager, failWrites } = fixture()
  const session = await manager.create({ title: 'Input', cwd: '/tmp', program: 'shell' }, human)
  failWrites(new Error('Terminal control connection closed'))
  await expect(manager.write(session.id, human, session.generation, 1, 'ls\r')).rejects.toThrow('control connection closed')
  await expect(manager.write(session.id, human, session.generation, 1, 'ls\r')).rejects.toThrow('sequence')
})

test('service setup runs in the same queue as creation, never in the middle of one', async () => {
  const { manager } = fixture()
  const order: string[] = []
  const creating = manager.create({ title: 'Racing', cwd: '/tmp', program: 'shell' }, human).then(() => order.push('created'))
  const setup = manager.setupService(async () => { order.push('setup') })
  await Promise.all([creating, setup])
  expect(order).toEqual(['created', 'setup'])
})

test('writeNext assigns the session sequence, so two viewers never collide', async () => {
  const { manager, writes } = fixture()
  const session = await manager.create({ title: 'Two', cwd: '/tmp', program: 'shell' }, human)
  const otherHuman = { kind: 'human', id: 'phone-123456789012' } as const
  await Promise.all([manager.writeNext(session.id, human, session.generation, 'a'), manager.writeNext(session.id, otherHuman, session.generation, 'b')])
  expect(writes).toEqual(['a', 'b'])
  expect(manager.get(session.id, human).inputSequence).toBe(2)
})

test('a delivery failure after the sequence is consumed is reported as uncertain', async () => {
  const { manager, failWrites } = fixture()
  const { DeliveryUncertainError } = await import('../lib/contracts')
  const session = await manager.create({ title: 'Uncertain', cwd: '/tmp', program: 'shell' }, human)
  failWrites(new Error('Terminal control connection closed'))
  const failure = await manager.writeNext(session.id, human, session.generation, 'x').catch((error) => error)
  expect(failure).toBeInstanceOf(DeliveryUncertainError)
  // A rejection before consumption is an ordinary TerminalError.
  const stale = await manager.writeNext(session.id, human, session.generation + 5, 'x').catch((error) => error)
  expect(stale).not.toBeInstanceOf(DeliveryUncertainError)
})

test('session-change listeners hear every saved change', async () => {
  const { manager } = fixture()
  const session = await manager.create({ title: 'Watched', cwd: '/tmp', program: 'shell', agentId: 'patch' }, human)
  const generations: number[] = []
  const unsubscribe = manager.onSessionChange(session.id, (changed) => generations.push(changed.generation))
  await manager.control(session.id, human, 'return')
  await manager.control(session.id, human, 'take')
  unsubscribe()
  await manager.control(session.id, human, 'return')
  expect(generations).toEqual([2, 3])
})

test('sessions start sized: the creating screen for a human, the configured default for an agent', async () => {
  const { manager } = fixture()
  const mine = await manager.create({ title: 'Mine', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'phone' })
  expect([mine.cols, mine.rows, mine.sizeEpoch, mine.sizeRevision]).toEqual([64, 20, 1, 0])
  expect(mine.sizeAuthority).toEqual({ viewer: human.id, kind: 'browser', device: 'phone' })
  const theirs = await manager.create({ title: 'Agent', cwd: '/tmp', program: 'shell' }, agent)
  expect([theirs.cols, theirs.rows, theirs.sizeEpoch]).toEqual([200, 60, 0])
  expect(theirs.sizeAuthority).toBeUndefined()
})

test('any human may claim, even while an agent drives; a former authority is stale', async () => {
  const { manager, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Shared', cwd: '/tmp', program: 'shell', agentId: 'patch' }, agent)
  const desk = { kind: 'human', id: 'desk-0123456789abcdef' } as const
  const phone = { kind: 'human', id: 'phone-0123456789abcdef' } as const
  const claimed = await manager.claim(session.id, desk, 180, 50, { kind: 'browser', device: 'desktop' })
  expect(claimed.sizeAuthority).toEqual({ viewer: desk.id, kind: 'browser', device: 'desktop' })
  expect([claimed.cols, claimed.rows, claimed.sizeEpoch, claimed.sizeRevision]).toEqual([180, 50, 1, 1])
  expect(claimed.owner).toEqual(agent)
  expect(tmuxSizes.get(session.id)).toEqual({ cols: 180, rows: 50 })
  const phoneClaim = await manager.claim(session.id, phone, 44, 30, { kind: 'browser', device: 'phone' })
  await expect(manager.resizeAs(session.id, desk, claimed.sizeEpoch, 200, 60)).rejects.toThrow('Another device is sizing this session')
  const followed = await manager.resizeAs(session.id, phone, phoneClaim.sizeEpoch, 44, 24)
  expect([followed.cols, followed.rows, followed.sizeRevision]).toEqual([44, 24, 3])
  await expect(manager.claim(session.id, agent, 100, 30, { kind: 'browser', device: 'desktop' })).rejects.toThrow()
})

test('claims clamp to the 40x10 floor', async () => {
  const { manager } = fixture()
  const session = await manager.create({ title: 'Tiny', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  const claimed = await manager.claim(session.id, human, 25, 4, { kind: 'browser', device: 'phone' })
  expect([claimed.cols, claimed.rows]).toEqual([40, 10])
})

test('a failed resize leaves every representation at tmux\'s actual window size', async () => {
  const { manager, failResizes } = fixture()
  const session = await manager.create({ title: 'Flaky', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  failResizes(new Error('resize-window failed'))
  const reconciled = await manager.resizeAs(session.id, human, session.sizeEpoch, 120, 40)
  expect([reconciled.cols, reconciled.rows]).toEqual([77, 22])
  failResizes(undefined)
})

test('a resize that cannot be reconciled drops the attachment; input is refused, never marked uncertain', async () => {
  const { manager, failResizes, failReadBack, attached, writes, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Lost', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  failResizes(new Error('resize-window failed'))
  failReadBack(new Error('tmux unreachable'))
  await expect(manager.resizeAs(session.id, human, session.sizeEpoch, 120, 40)).rejects.toThrow('reconnect required')
  expect(attached.has(session.id)).toBe(false)
  await expect(manager.writeNext(session.id, human, session.generation, 'ls\r')).rejects.toThrow('reconnect required')
  expect(manager.get(session.id, human).inputSequence).toBe(0)
  expect(writes).toEqual([])
  // tmux moved after all; the next join reattaches and adopts its real window.
  failResizes(undefined)
  failReadBack(undefined)
  tmuxSizes.set(session.id, { cols: 77, rows: 22 })
  await manager.ensureReplica(session.id, human)
  expect(manager.get(session.id, human)).toMatchObject({ cols: 77, rows: 22, sizeRevision: 1 })
})

test('a record that fails to save after tmux resized is reconciled from tmux on the next attachment', async () => {
  const { manager, attached, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Disk', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  const save = manager.store.save.bind(manager.store)
  let failing = true
  manager.store.save = (next) => { if (failing) throw new Error('disk full'); save(next) }
  await expect(manager.resizeAs(session.id, human, session.sizeEpoch, 120, 40)).rejects.toThrow('reconnect required')
  expect(tmuxSizes.get(session.id)).toEqual({ cols: 120, rows: 40 })
  expect(attached.has(session.id)).toBe(false)
  failing = false
  await manager.ensureReplica(session.id, human)
  expect(manager.get(session.id, human)).toMatchObject({ cols: 120, rows: 40 })
  expect(manager.store.sessions().find((stored) => stored.id === session.id)).toMatchObject({ cols: 120, rows: 40 })
})

test('reattaching after setup adopts tmux\'s window, even when the stored record is stale', async () => {
  const { manager, tmuxSizes, live } = fixture()
  const session = await manager.create({ title: 'Restart', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  // tmux moved, but the record never heard (a save that failed before a restart).
  tmuxSizes.set(session.id, { cols: 120, rows: 40 })
  live.add(session.id)
  await manager.setupService(async () => {})
  await manager.ensureReplica(session.id, human)
  expect(manager.get(session.id, human)).toMatchObject({ cols: 120, rows: 40 })
  expect(manager.store.sessions().find((stored) => stored.id === session.id)).toMatchObject({ cols: 120, rows: 40 })
})

const operator = { kind: 'human', id: 'cli' } as const
/** Launched by the CLI, a terminal app attaches read-only until admitted. */
const ghostty = (pid: number, cols = 120, rows = 40, readonly = true): NativeClient => ({ pid, name: `/dev/ttys00${pid % 10}`, cols, rows, readonly, control: false })

test('a terminal app attaches only through a confirmed reservation, then sizes the session', async () => {
  const { manager, nativeAttach, detachedClients, natives } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  expect(reserved.args).toEqual(['-S', '/tmp/t.sock', 'attach-session', '-t', session.id])
  // tmux can attach before the CLI's confirm arrives: held, not detached.
  await nativeAttach(session.id, ghostty(501))
  expect(detachedClients).toEqual([])
  expect(manager.nativeClients(session.id)).toEqual([])
  expect(natives.get(session.id)?.[0]?.readonly).toBe(true)
  await manager.confirmAttach(reserved.token, 501)
  expect(manager.nativeClients(session.id).map((client) => client.pid)).toEqual([501])
  // Admitted, it can type.
  expect(natives.get(session.id)?.[0]?.readonly).toBe(false)
  const sized = manager.get(session.id, human)
  expect(sized.sizeAuthority).toEqual({ viewer: 'native:501', kind: 'native' })
  expect([sized.cols, sized.rows]).toEqual([120, 40])
  // The app's window resizes: the session follows (clamped to the floor).
  await nativeAttach(session.id, ghostty(501, 30, 8, false))
  expect([manager.get(session.id, human).cols, manager.get(session.id, human).rows]).toEqual([40, 10])
  // A reservation is single-use.
  await expect(manager.confirmAttach(reserved.token, 777)).rejects.toThrow('run the command again')
})

test('an unreserved attach (a raw tmux attach) is detached at once', async () => {
  const { manager, nativeAttach, detachedClients } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  await nativeAttach(session.id, ghostty(601))
  expect(detachedClients).toEqual(['/dev/ttys001'])
  expect(manager.nativeClients(session.id)).toEqual([])
})

test('an expired reservation admits nothing, and its waiting client is detached', async () => {
  const { manager, nativeAttach, detachedClients, later } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  await nativeAttach(session.id, ghostty(702))
  later(15_001)
  await expect(manager.confirmAttach(reserved.token, 702)).rejects.toThrow('expired')
  await nativeAttach(session.id, ghostty(702))
  expect(detachedClients).toEqual(['/dev/ttys002'])
})

test('agent-owned sessions refuse a terminal app; take, return and assign invalidate reservations', async () => {
  const { manager } = fixture()
  const session = await manager.create({ title: 'Agent', cwd: '/tmp' }, agent)
  await expect(manager.reserveAttach(session.id, operator)).rejects.toThrow('Take control first')
  await expect(manager.reserveAttach(session.id, agent)).rejects.toThrow('Only the human')
  await manager.control(session.id, human, 'take')
  for (const operation of ['take', 'assign'] as const) {
    const reserved = await manager.reserveAttach(session.id, operator)
    await manager.control(session.id, human, operation, operation === 'assign' ? 'patch' : undefined)
    await expect(manager.confirmAttach(reserved.token, 1)).rejects.toThrow('run the command again')
  }
})

test('Return detaches every admitted terminal app before the agent drives', async () => {
  const { manager, nativeAttach, detachedClients } = fixture()
  const session = await manager.create({ title: 'Agent', cwd: '/tmp' }, agent)
  await manager.control(session.id, human, 'take')
  const reserved = await manager.reserveAttach(session.id, operator)
  // The confirm can arrive before tmux has attached: it waits for the admission.
  const confirmed = manager.confirmAttach(reserved.token, 803)
  await manager.idle()
  await nativeAttach(session.id, ghostty(803))
  await confirmed
  expect(manager.nativeClients(session.id)).toHaveLength(1)
  const returned = await manager.control(session.id, human, 'return')
  expect(detachedClients).toEqual(['/dev/ttys003'])
  expect(manager.nativeClients(session.id)).toEqual([])
  expect(returned.owner).toEqual(agent)
})

test('the app leaving is heard, and a browser claim stops following it', async () => {
  const { manager, nativeAttach, nativeLeave } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const heard: number[] = []
  manager.onNatives(session.id, () => heard.push(manager.nativeClients(session.id).length))
  const reserved = await manager.reserveAttach(session.id, operator)
  await nativeAttach(session.id, ghostty(904))
  await manager.confirmAttach(reserved.token, 904)
  await manager.claim(session.id, human, 100, 30, { kind: 'browser', device: 'desktop' })
  await nativeAttach(session.id, ghostty(904, 150, 50, false))
  expect([manager.get(session.id, human).cols, manager.get(session.id, human).rows]).toEqual([100, 30])
  await nativeLeave(session.id, 904)
  expect(heard).toEqual([1, 1, 0])
})

test('while a confirm is pending, every unmatched client is held unable to type, and Return detaches held clients too', async () => {
  const { manager, nativeAttach, natives, detachedClients } = fixture()
  const session = await manager.create({ title: 'Agent', cwd: '/tmp' }, agent)
  await manager.control(session.id, human, 'take')
  await manager.reserveAttach(session.id, operator)
  // A raw attach that slips into the window (writable) is made read-only while it waits.
  await nativeAttach(session.id, ghostty(311, 80, 24, false))
  expect(natives.get(session.id)?.[0]).toMatchObject({ pid: 311, readonly: true })
  expect(detachedClients).toEqual([])
  const returned = await manager.control(session.id, human, 'return')
  expect(detachedClients).toEqual(['/dev/ttys001'])
  expect(natives.get(session.id)).toEqual([])
  expect(returned.owner).toEqual(agent)
})

test('ending or deleting a session forgets its terminal apps', async () => {
  const { manager, nativeAttach, live } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const heard: number[] = []
  manager.onNatives(session.id, () => heard.push(manager.nativeClients(session.id).length))
  const reserved = await manager.reserveAttach(session.id, operator)
  await nativeAttach(session.id, ghostty(412))
  await manager.confirmAttach(reserved.token, 412)
  live.delete(session.id)
  await manager.refreshStates()
  expect(manager.nativeClients(session.id)).toEqual([])
  expect(heard).toEqual([1, 0])
  await expect(manager.reserveAttach(session.id, operator)).rejects.toThrow('exited')
})

test('a CLI-created session starts at the caller\'s terminal size, sized by the terminal app', async () => {
  const { manager, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Here', cwd: '/tmp', checkout: 'existing' }, operator, { cols: 90, rows: 28, kind: 'native' })
  expect([session.cols, session.rows]).toEqual([90, 28])
  expect(tmuxSizes.get(session.id)).toEqual({ cols: 90, rows: 28 })
  expect(session.sizeAuthority).toEqual({ viewer: 'cli', kind: 'native' })
})

test('an isolated checkout is prepared for a shell too; a shell defaults to the existing checkout', async () => {
  const prepared: string[] = []
  const driver = { create: async () => {}, attach() {}, connected: () => true, write: async () => {}, resize: async () => {}, windowSize: async () => ({ cols: 200, rows: 60 }), title: async () => {}, alive: async () => true, terminate: async () => {}, inUse: async () => false, detach: async () => {}, clients: async () => [], detachClient: async () => {}, setReadonly: async () => {}, attachArgs: () => [] } satisfies ProcessDriver
  const manager = new Sessions(new Store(':memory:'), driver, {
    settings: () => ({ enabledAgents: [] }),
    prepare: async (input) => { prepared.push(input.sessionId); return { ok: true, worktreePath: '/tmp' } },
    release: async () => ({ ok: true }),
  })
  managers.push(manager)
  const plain = await manager.create({ title: 'Plain', cwd: '/tmp' }, human)
  expect(plain.worktreePath).toBeUndefined()
  const isolated = await manager.create({ title: 'Isolated', cwd: '/tmp', checkout: 'isolated' }, human)
  expect(prepared).toEqual([isolated.id])
  expect(isolated.worktreePath).toBe('/tmp')
})

test('a confirm resolves only on admission, and rejects when the reservation lapses first', async () => {
  const { manager, nativeAttach, detachedClients } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  const confirmed = manager.confirmAttach(reserved.token, 515)
  await manager.idle()
  // Control changes before tmux attaches: the CLI hears it was turned away.
  await manager.control(session.id, human, 'take')
  await expect(confirmed).rejects.toThrow('Control changed')
  await nativeAttach(session.id, ghostty(515))
  expect(detachedClients).toEqual(['/dev/ttys005'])
})

test('a foreign control-mode client is detached even while a confirm is pending', async () => {
  const { manager, nativeAttach, detachedClients } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  await manager.reserveAttach(session.id, operator)
  await nativeAttach(session.id, { ...ghostty(626, 80, 24, false), control: true })
  expect(detachedClients).toEqual(['/dev/ttys006'])
})

test('a client that leaves mid-reconcile does not undo another client\'s admission', async () => {
  const { manager, natives, nativeAttach, vanishing, detachedClients } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  // Listed beside 737 but gone before it is acted on: skipped, and 737 is still admitted.
  vanishing.add(838)
  natives.set(session.id, [ghostty(838, 80, 24, false), ghostty(737)])
  await manager.confirmAttach(reserved.token, 737)
  expect(manager.nativeClients(session.id).map((client) => client.pid)).toEqual([737])
  expect(detachedClients).toEqual([])
  // Later reconciles keep it.
  await nativeAttach(session.id, ghostty(737, 100, 30, false))
  expect(manager.nativeClients(session.id).map((client) => client.pid)).toEqual([737])
})

test('an admission survives a later client failing in the same pass, and the confirm resolves', async () => {
  const { manager, natives, nativeAttach } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  const confirmed = manager.confirmAttach(reserved.token, 941)
  await manager.idle()
  // 941 is admitted first; then a stuck client's detach fails for real (it is still listed).
  const driver = (manager as unknown as { driver: { detachClient(name: string): Promise<void> } }).driver
  const detach = driver.detachClient
  driver.detachClient = async (name) => { if (name === 'stuck') throw new Error('server busy'); return detach(name) }
  natives.set(session.id, [ghostty(941)])
  await nativeAttach(session.id, { ...ghostty(942, 80, 24, false), control: true, name: 'stuck' })
  await confirmed
  expect(manager.nativeClients(session.id).map((client) => client.pid)).toEqual([941])
  expect(manager.get(session.id, human).sizeAuthority).toEqual({ viewer: 'native:941', kind: 'native' })
})

test('a confirm whose admission pass fails is refused, not left waiting', async () => {
  const { manager, natives } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  natives.set(session.id, [ghostty(951)])
  const driver = (manager as unknown as { driver: { setReadonly(): Promise<void> } }).driver
  driver.setReadonly = async () => { throw new Error('server busy') }
  await expect(manager.confirmAttach(reserved.token, 951)).rejects.toThrow('Could not admit this terminal: server busy')
})

test('the admitted app is sized even when another client fails in the same pass', async () => {
  const { manager, natives, nativeAttach, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  const confirmed = manager.confirmAttach(reserved.token, 961)
  await manager.idle()
  const driver = (manager as unknown as { driver: { detachClient(name: string): Promise<void> } }).driver
  driver.detachClient = async () => { throw new Error('server busy') }
  natives.set(session.id, [{ ...ghostty(962, 80, 24, false), control: true, name: 'stuck' }])
  await nativeAttach(session.id, ghostty(961, 120, 40))
  await confirmed
  expect(tmuxSizes.get(session.id)).toEqual({ cols: 120, rows: 40 })
  expect([manager.get(session.id, human).cols, manager.get(session.id, human).rows]).toEqual([120, 40])
})

test('an admission whose size claim cannot be saved is revoked: detached and refused', async () => {
  const { manager, natives, detachedClients } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  natives.set(session.id, [ghostty(971)])
  const store = manager.store as unknown as { save(session: unknown): void }
  const save = store.save.bind(store)
  store.save = () => { throw new Error('disk full') }
  await expect(manager.confirmAttach(reserved.token, 971)).rejects.toThrow('Could not admit this terminal')
  store.save = save
  expect(manager.nativeClients(session.id)).toEqual([])
  expect(detachedClients).toEqual(['/dev/ttys001'])
})

test('a viewer listener that throws does not stop an admission', async () => {
  const { manager, natives } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  manager.onSessionChange(session.id, () => { throw new Error('viewer gone') })
  manager.onNatives(session.id, () => { throw new Error('viewer gone') })
  const reserved = await manager.reserveAttach(session.id, operator)
  natives.set(session.id, [ghostty(981)])
  await manager.confirmAttach(reserved.token, 981)
  expect(manager.nativeClients(session.id).map((client) => client.pid)).toEqual([981])
  expect(manager.get(session.id, human).sizeAuthority).toEqual({ viewer: 'native:981', kind: 'native' })
})

test('an admission whose resize cannot be reconciled is revoked too', async () => {
  const { manager, natives, detachedClients, failResizes, failReadBack } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  natives.set(session.id, [ghostty(991, 120, 40)])
  failResizes(new Error('tmux refused'))
  failReadBack(new Error('tmux gone'))
  await expect(manager.confirmAttach(reserved.token, 991)).rejects.toThrow('Could not admit this terminal')
  expect(manager.nativeClients(session.id)).toEqual([])
  expect(detachedClients).toEqual(['/dev/ttys001'])
})

test('a fresh client stays read-only until its claim and resize are in place, and if they fail', async () => {
  const { manager, natives, failResizes, failReadBack } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const reserved = await manager.reserveAttach(session.id, operator)
  natives.set(session.id, [ghostty(995, 120, 40)])
  const driver = (manager as unknown as { driver: { resize(id: string, cols: number, rows: number): Promise<void> } }).driver
  const resize = driver.resize
  let release!: () => void
  let entered!: () => void
  const resizing = new Promise<void>((resolve) => { entered = resolve })
  driver.resize = async (...args) => { entered(); await new Promise<void>((resolve) => { release = resolve }); return resize(...args) }
  const confirmed = manager.confirmAttach(reserved.token, 995)
  await resizing
  expect(natives.get(session.id)?.[0]?.readonly).toBe(true)
  release()
  await confirmed
  expect(natives.get(session.id)?.[0]?.readonly).toBe(false)
  // And when sizing fails, it never became writable before being detached.
  driver.resize = resize
  const second = await manager.reserveAttach(session.id, operator)
  const seen: boolean[] = []
  const setReadonly = (manager as unknown as { driver: { setReadonly(id: string, client: unknown, readonly: boolean): Promise<void> } }).driver
  const original = setReadonly.setReadonly
  setReadonly.setReadonly = async (id, client, readonly) => { seen.push(readonly); return original(id, client, readonly) }
  natives.set(session.id, [...natives.get(session.id)!, ghostty(996, 90, 30)])
  failResizes(new Error('tmux refused'))
  failReadBack(new Error('tmux gone'))
  await expect(manager.confirmAttach(second.token, 996)).rejects.toThrow('Could not admit this terminal')
  expect(seen).not.toContain(false)
})

test('one fresh client leaving before it can type does not revoke another', async () => {
  const { manager, natives } = fixture()
  const session = await manager.create({ title: 'Mac', cwd: '/tmp' }, human)
  const first = await manager.reserveAttach(session.id, operator)
  const second = await manager.reserveAttach(session.id, operator)
  const driver = (manager as unknown as { driver: { resize(id: string, cols: number, rows: number): Promise<void> } }).driver
  const resize = driver.resize
  // Both confirmed before either attaches; then both attach and 1001 closes while the session resizes.
  const a = manager.confirmAttach(first.token, 1001)
  const b = manager.confirmAttach(second.token, 1002)
  await manager.idle()
  driver.resize = async (...args) => { natives.set(session.id, natives.get(session.id)!.filter((client) => client.pid !== 1001)); return resize(...args) }
  natives.set(session.id, [ghostty(1001), ghostty(1002, 110, 35)])
  ;(manager as unknown as { clientsChanged(id: string): void }).clientsChanged(session.id)
  await expect(a).rejects.toThrow('left before it was admitted')
  await b
  expect(manager.nativeClients(session.id).map((client) => client.pid)).toEqual([1002])
  expect(natives.get(session.id)?.[0]?.readonly).toBe(false)
})

test('a join recovers a lost replica (none, ended, or its control client closed) by attaching again; a live one is left alone', async () => {
  const { manager, attaches, replicas, controlLost } = fixture()
  const session = await manager.create({ title: 'Raw', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  expect(attaches).toEqual([session.id])
  // No replica (it ended, or a server restart left none): attached again.
  await manager.ensureReplica(session.id, human)
  expect(attaches).toHaveLength(2)
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bc'), cols: 64, rows: 20, reason: 'test', history: true })
  replicas.set(session.id, replica)
  await manager.ensureReplica(session.id, human)
  expect(await manager.readScreen(session.id, human)).toMatchObject({ cols: 64, rows: 20 })
  expect(attaches).toHaveLength(2)
  // The control client closed: a replica loss too.
  controlLost.add(session.id)
  await manager.ensureReplica(session.id, human)
  expect(attaches).toHaveLength(3)
  // An ended replica (a failed reseed) likewise.
  replica.close()
  await manager.ensureReplica(session.id, human)
  expect(attaches).toHaveLength(4)
})
test("a join to a live replica waits for nothing, even while another session's attachment holds the queue", async () => {
  const { manager, replicas, tmuxSizes } = fixture()
  const live = await manager.create({ title: 'Live', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  replicas.set(live.id, replica)
  const other = await manager.create({ title: 'Other', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  // The other session's recovery is stuck reading tmux's window size, holding the queue.
  let release!: () => void
  const stuck = new Promise<void>((resolve) => { release = resolve })
  const size = tmuxSizes.get(other.id)!
  const original = manager['driver'].windowSize
  manager['driver'].windowSize = async (id: string) => { if (id === other.id) { await stuck; return size } return original(id) }
  const recovering = manager.ensureReplica(other.id, human)
  let joined = false
  await manager.ensureReplica(live.id, human).then(() => { joined = true })
  expect(joined).toBe(true)
  release()
  await recovering
  replica.close()
})

test('readScreen takes the screen, the grid and the size revision from the replica in one step (adoptSize never moves it)', async () => {
  const { manager, replicas, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Raw', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  // No replica, or one not seeded yet: not ready.
  await expect(manager.readScreen(session.id, human)).rejects.toThrow('not ready')
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  replicas.set(session.id, replica)
  await expect(manager.readScreen(session.id, human)).rejects.toThrow('not ready')
  let seq = 0
  await replica.event({ seq: ++seq, kind: 'seed', bytes: new TextEncoder().encode('\x1bcfrom the replica'), cols: 64, rows: 20, reason: 'test', history: true })
  expect(await manager.readScreen(session.id, human)).toMatchObject({ cols: 64, rows: 20, sizeRevision: 0 })
  expect((await manager.readScreen(session.id, human)).screen.split('\n')[0]).toBe('from the replica')
  // A row change and a same-size layout: one revision.
  await replica.event({ seq: ++seq, kind: 'layout', cols: 64, rows: 24 })
  await replica.event({ seq: ++seq, kind: 'layout', cols: 64, rows: 24 })
  expect(await manager.readScreen(session.id, human)).toMatchObject({ cols: 64, rows: 24, sizeRevision: 1 })
  // The record adopts another size (a reconcile): the raw revision is the replica's, unmoved.
  tmuxSizes.set(session.id, { cols: 90, rows: 30 })
  await manager.resizeAs(session.id, human, session.sizeEpoch, 90, 30)
  expect(manager.get(session.id, human).sizeRevision).toBeGreaterThan(0)
  expect(await manager.readScreen(session.id, human)).toMatchObject({ cols: 64, rows: 24, sizeRevision: 1 })
  // A seed at another size (layouts a rebuild skipped) is a dimension change too.
  await replica.event({ seq: seq + 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bc'), cols: 90, rows: 30, reason: 'test', history: true })
  expect(await manager.readScreen(session.id, human)).toMatchObject({ cols: 90, rows: 30, sizeRevision: 2 })
  replica.close()
})

describe('final output (plan T35b)', () => {
  const picture = async () => {
    const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
    await replica.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode('\x1bclast words'), cols: 64, rows: 20, reason: 'test', history: true })
    const cut = replica.cut()!
    replica.close()
    return cut
  }
  it('a new session expects a bundle; terminate saves it before the kill, from a drain to a control reply', async () => {
    const { manager, finals, finalCut, store } = fixture()
    const session = await manager.create({ title: 'Ends', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    expect(session.outputSaved).toBe(false)
    const cut = await picture()
    finalCut.next = async () => cut
    const taken = await manager.control(session.id, human, 'take')
    const ended = await manager.finish(session.id, human, taken.generation, true)
    expect(finals).toEqual([`final ${session.id} boundary=true`, `terminate ${session.id}`])
    expect(ended).toMatchObject({ state: 'completed', outputSaved: true })
    expect((await store.bundle(session.id))?.cut.tail).toEqual(cut.tail)
    expect((await store.bundle(session.id))?.cut.checkpoint.data.join('')).toBe(cut.checkpoint.data.join(''))
  })
  it('no picture in time, a failed drain, or a failed bundle write records output not saved and never blocks the termination', async () => {
    for (const failure of ['no picture', 'drain throws', 'write throws'] as const) {
      const { manager, finals, finalCut, store } = fixture()
      const session = await manager.create({ title: 'Ends', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
      const cut = await picture()
      finalCut.next = failure === 'no picture' ? async () => undefined : failure === 'drain throws' ? async () => { throw new Error('control lost') } : async () => cut
      if (failure === 'write throws') store.saveBundle = async () => { throw new Error('disk full') }
      const taken = await manager.control(session.id, human, 'take')
      const ended = await manager.finish(session.id, human, taken.generation, true)
      expect(finals.at(-1)).toBe(`terminate ${session.id}`)
      expect(ended).toMatchObject({ state: 'completed', outputSaved: false })
      expect(await store.bundle(session.id)).toBeUndefined()
    }
  })
  it("the program's exit saves it once (the pane stays), and completing the session later saves nothing more", async () => {
    const { manager, finals, finalCut, live, store } = fixture()
    const session = await manager.create({ title: 'Exits', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const cut = await picture()
    finalCut.next = async () => cut
    live.delete(session.id)
    await manager.refreshStates()
    expect(manager.get(session.id, human)).toMatchObject({ state: 'exited', outputSaved: true })
    expect((await store.bundle(session.id))?.cut.tail).toEqual(cut.tail)
    expect((await store.bundle(session.id))?.cut.checkpoint.data.join('')).toBe(cut.checkpoint.data.join(''))
    await manager.finish(session.id, human, manager.get(session.id, human).generation, false)
    expect(finals.filter((entry) => entry.startsWith('final'))).toHaveLength(1)
  })
  it("tmux's pane-died hint saves it without waiting for a poll", async () => {
    const { manager, finals, finalCut, live, paneDied } = fixture()
    const session = await manager.create({ title: 'Exits', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    finalCut.next = picture
    live.delete(session.id)
    paneDied.get(session.id)!()
    for (let tries = 0; tries < 100 && manager.get(session.id, human).outputSaved !== true; tries++) await Bun.sleep(5)
    expect(manager.get(session.id, human)).toMatchObject({ state: 'exited', outputSaved: true })
    expect(finals).toEqual([`final ${session.id} boundary=true`])
  })
  it('a save that failed at the exit is tried again before maintenance completes the session', async () => {
    const { manager, finals, finalCut, live, advance, terminated } = fixture()
    const session = await manager.create({ title: 'Idle', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    live.delete(session.id)
    await manager.refreshStates()
    expect(manager.get(session.id, human).outputSaved).toBe(false)
    finalCut.next = picture
    advance()
    await manager.sweep()
    expect(manager.get(session.id, human)).toMatchObject({ state: 'completed', outputSaved: true })
    expect(finals.filter((entry) => entry.startsWith('final'))).toHaveLength(2)
    // Saved first, then completed (terminated).
    expect(finals.at(-1)).toBe(`terminate ${session.id}`)
    expect(terminated).toEqual([session.id])
  })
  it('the ending session refuses input from its reservation on: nothing typed after its final picture is taken', async () => {
    const { manager, finalCut, writes } = fixture()
    const ending = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const taken = await manager.control(ending.id, human, 'take')
    const finishing = manager.finish(ending.id, human, taken.generation, true)
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    await expect(manager.write(ending.id, human, taken.generation, taken.inputSequence + 1, 'POST-CUT\r')).rejects.toThrow('Session is ending')
    expect(writes).toEqual([])
    release(await picture())
    await finishing
  })
  it('the reservation holds until the kill: input queued while the save finishes is refused, not delivered', async () => {
    const { manager, finalCut, writes } = fixture()
    const ending = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const other = await manager.create({ title: 'Other', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const taken = await manager.control(ending.id, human, 'take')
    const otherTaken = await manager.control(other.id, human, 'take')
    const finishing = manager.finish(ending.id, human, taken.generation, true)
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    // Another session's input holds the queue; the ending session's input waits behind it.
    let unblock!: () => void
    const original = manager['driver'].write
    manager['driver'].write = async (id: string, data: string) => { if (id === other.id) await new Promise<void>((resolve) => { unblock = resolve }); return original(id, data) }
    const blocked = manager.write(other.id, human, otherTaken.generation, otherTaken.inputSequence + 1, 'other\r')
    const late = manager.write(ending.id, human, taken.generation, taken.inputSequence + 1, 'POST-CUT\r')
    for (let tries = 0; tries < 100 && !unblock; tries++) await Bun.sleep(1)
    // The save settles now, before the kill's turn in the queue.
    release(await picture())
    await Bun.sleep(5)
    unblock()
    await blocked
    await expect(late).rejects.toThrow('Session is ending')
    expect(writes).toEqual(['other\r'])
    await finishing
  })
  it('shutdown waits for a finish to complete its kill, and for the refresh hints still owed', async () => {
    const { manager, finalCut, terminated, store } = fixture()
    const session = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const taken = await manager.control(session.id, human, 'take')
    const finishing = manager.finish(session.id, human, taken.generation, true)
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    let closed = false
    const original = store.close.bind(store)
    store.close = () => { if (!closed) expect(terminated).toEqual([session.id]); closed = true; original() }
    const stopping = manager.shutdown()
    await Bun.sleep(10)
    release(await picture())
    await finishing
    await stopping
    expect(closed).toBe(true)
  })
  it('shutdown runs the refresh still owed to a hint that came during one (a second death is not dropped)', async () => {
    const { manager, finalCut, live, paneDied, store } = fixture()
    const first = await manager.create({ title: 'First', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const second = await manager.create({ title: 'Second', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    live.delete(first.id)
    paneDied.get(first.id)!()
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    // The second dies while the first's save holds that refresh open.
    live.delete(second.id)
    paneDied.get(second.id)!()
    let states: string[] = []
    const original = store.close.bind(store)
    store.close = () => { if (!states.length) states = store.sessions().filter((session) => session.id === second.id).map((session) => session.state); original() }
    const stopping = manager.shutdown()
    finalCut.next = picture
    release(await picture())
    await stopping
    expect(states).toEqual(['exited'])
  })
  it('two finishes at once: one refused early never releases the other\'s reservation', async () => {
    const { manager, finalCut, writes } = fixture()
    const session = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const other = await manager.create({ title: 'Other', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const taken = await manager.control(session.id, human, 'take')
    const otherTaken = await manager.control(other.id, human, 'take')
    const refused = manager.finish(session.id, human, taken.generation, false)
    const finishing = manager.finish(session.id, human, taken.generation, true)
    await expect(refused).rejects.toThrow('still running')
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    // Input queued behind another session's, while the save settles before the kill's turn.
    let unblock!: () => void
    const original = manager['driver'].write
    manager['driver'].write = async (id: string, data: string) => { if (id === other.id) await new Promise<void>((resolve) => { unblock = resolve }); return original(id, data) }
    const blocked = manager.write(other.id, human, otherTaken.generation, otherTaken.inputSequence + 1, 'other\r')
    const late = manager.write(session.id, human, taken.generation, taken.inputSequence + 1, 'POST-CUT\r')
    for (let tries = 0; tries < 100 && !unblock; tries++) await Bun.sleep(1)
    release(await picture())
    await Bun.sleep(5)
    unblock()
    await blocked
    await expect(late).rejects.toThrow('Session is ending')
    expect(writes).toEqual(['other\r'])
    expect((await finishing).state).toBe('completed')
  })
  it('shutdown drains until nothing is left: deaths heard while it waits for a finish are saved too', async () => {
    const { manager, finalCut, live, paneDied, store } = fixture()
    const ending = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const a = await manager.create({ title: 'A', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const b = await manager.create({ title: 'B', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const releases: Array<(cut: Cut | undefined) => void> = []
    finalCut.next = () => new Promise((resolve) => { releases.push(resolve) })
    const taken = await manager.control(ending.id, human, 'take')
    const finishing = manager.finish(ending.id, human, taken.generation, true)
    for (let tries = 0; tries < 100 && !releases.length; tries++) await Bun.sleep(1)
    let states: Record<string, string> = {}
    const original = store.close.bind(store)
    store.close = () => { if (!Object.keys(states).length) states = Object.fromEntries(store.sessions().map((session) => [session.title, session.state])); original() }
    const stopping = manager.shutdown()
    await Bun.sleep(5)
    // While shutdown waits for the finish: A dies (its refresh holds on A's save), then B (a rerun owed).
    live.delete(a.id)
    paneDied.get(a.id)!()
    for (let tries = 0; tries < 100 && releases.length < 2; tries++) await Bun.sleep(1)
    live.delete(b.id)
    paneDied.get(b.id)!()
    finalCut.next = picture
    for (const release of releases.splice(0)) release(await picture())
    await finishing
    await stopping
    expect(states).toMatchObject({ Ending: 'completed', A: 'exited', B: 'exited' })
  })
  it('shutdown waits for a refresh still in the queue, and the save it then starts', async () => {
    const { manager, finalCut, live, store } = fixture()
    const session = await manager.create({ title: 'Exits', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    finalCut.next = picture
    let answer!: () => void
    const original = manager['driver'].alive
    manager['driver'].alive = async (id: string) => { await new Promise<void>((resolve) => { answer = resolve }); return original(id) }
    live.delete(session.id)
    const refreshing = manager.refreshStates()
    for (let tries = 0; tries < 100 && !answer; tries++) await Bun.sleep(1)
    let saved: boolean | undefined
    const close = store.close.bind(store)
    store.close = () => { if (saved === undefined) saved = store.session(session.id)?.outputSaved; close() }
    const stopping = manager.shutdown()
    await Bun.sleep(5)
    answer()
    await refreshing
    await stopping
    expect(saved).toBe(true)
  })
  it('shutdown takes no more pane-died hints: endless hints never keep it from finishing', async () => {
    const { manager, paneDied } = fixture()
    const session = await manager.create({ title: 'Lives', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    // Each refresh's liveness check outlasts the gap between hints: one is always owed.
    const original = manager['driver'].alive
    manager['driver'].alive = async (id: string) => { await Bun.sleep(5); return original(id) }
    let hinting = true
    const hints = (async () => { while (hinting) { paneDied.get(session.id)!(); await Bun.sleep(1) } })()
    await Bun.sleep(10)
    const started = performance.now()
    await manager.shutdown()
    hinting = false
    await hints
    expect(performance.now() - started).toBeLessThan(1000)
  })
  it('once shutdown starts, new lifecycle work is refused (a refresh, a finish, a sweep); accepted work still completes', async () => {
    const { manager, finalCut, live, store } = fixture()
    const accepted = await manager.create({ title: 'Accepted', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const late = await manager.create({ title: 'Late', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const taken = await manager.control(accepted.id, human, 'take')
    const finishing = manager.finish(accepted.id, human, taken.generation, true)
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    const stopping = manager.shutdown()
    const lateTaken = store.session(late.id)!
    await expect(manager.refreshStates()).rejects.toThrow('shutting down')
    await expect(manager.finish(late.id, human, lateTaken.generation, true)).rejects.toThrow('shutting down')
    live.delete(late.id)
    await expect(manager.sweep()).rejects.toThrow('shutting down')
    release(await picture())
    expect((await finishing).state).toBe('completed')
    await stopping
  })
  it('queued work accepted before shutdown completes before the store closes; a call after it starts is refused', async () => {
    const { manager, store } = fixture()
    let installed = false
    let finishInstall!: () => void
    // Before the cutoff: a Set up service whose installer is still running.
    const setup = manager.setupService(() => new Promise<void>((resolve) => { finishInstall = () => { installed = true; resolve() } }))
    for (let tries = 0; tries < 100 && !finishInstall; tries++) await Bun.sleep(1)
    let installedAtClose: boolean | undefined
    const close = store.close.bind(store)
    store.close = () => { installedAtClose ??= installed; close() }
    const stopping = manager.shutdown()
    // After the cutoff: refused at once.
    await expect(manager.create({ title: 'Late', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })).rejects.toThrow('shutting down')
    await Bun.sleep(5)
    finishInstall()
    await setup
    await stopping
    expect(installedAtClose).toBe(true)
  })
  it('a sweep accepted before shutdown runs to its end (its save, then its maintenance), and shutdown waits for it', async () => {
    const { manager, finalCut, live, terminated, advance } = fixture()
    const session = await manager.create({ title: 'Idle', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    live.delete(session.id)
    await manager.refreshStates()
    advance()
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const sweeping = manager.sweep()
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    const stopping = manager.shutdown()
    await Bun.sleep(5)
    release(await picture())
    await sweeping
    await stopping
    expect(terminated).toEqual([session.id])
  })
  it('a kill that fails after the save leaves the program running: that bundle is not final, and the real end saves again', async () => {
    const { manager, finalCut, finals, store } = fixture()
    const session = await manager.create({ title: 'Survives', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    finalCut.next = picture
    const original = manager['driver'].terminate
    manager['driver'].terminate = async () => { throw new Error('kill failed') }
    const taken = await manager.control(session.id, human, 'take')
    await expect(manager.finish(session.id, human, taken.generation, true)).rejects.toThrow('kill failed')
    expect(store.hasBundle(session.id)).toBe(false)
    expect(manager.get(session.id, human)).toMatchObject({ state: 'running', outputSaved: false })
    manager['driver'].terminate = original
    await manager.finish(session.id, human, taken.generation, true)
    expect(finals.filter((entry) => entry.startsWith('final'))).toHaveLength(2)
    expect(manager.get(session.id, human)).toMatchObject({ state: 'completed', outputSaved: true })
  })
  it('a terminate during a rebuild: its seed in time is the final picture (never the obsolete base); none in time is not saved; both survive a reopen', async () => {
    for (const lands of [true, false]) {
      const path = join(tmpdir(), `terminal-final-${crypto.randomUUID()}.db`)
      try {
        const { manager, finalCut, store } = fixture({ storePath: path })
        const session = await manager.create({ title: 'Rebuilding', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
        // A real replica on a real log: its base is now obsolete (an overload rebuild began).
        const reseeds: string[] = []
        const replica = new Replica({ reseed: (reason, turn) => turn(async () => { reseeds.push(reason) }), geometry: (_generation, turn) => turn(async () => undefined), idleMs: 1e9 })
        const log = new OutputLog()
        log.attach(replica)
        log.seed(new TextEncoder().encode('\x1bcobsolete base'), 64, 20, 'attach')
        for (let tries = 0; tries < 200 && !replica.cut(); tries++) await Bun.sleep(1)
        replica.pressure(MAX_BACKLOG_BYTES)
        finalCut.next = async () => {
          if (lands) setTimeout(() => log.seed(new TextEncoder().encode('\x1bcfresh picture'), 64, 20, 'overload', false), 30)
          return drainFinal(replica, log, undefined, 300)
        }
        const taken = await manager.control(session.id, human, 'take')
        const ended = await manager.finish(session.id, human, taken.generation, true)
        expect(ended.outputSaved).toBe(lands)
        replica.close()
        store.close()
        const reopened = new Store(path)
        expect(reopened.session(session.id)?.outputSaved).toBe(lands)
        const saved = await reopened.bundle(session.id)
        if (lands) {
          expect(saved?.cut.checkpoint.data.join('')).toContain('fresh picture')
          expect(saved?.cut.checkpoint.data.join('')).not.toContain('obsolete base')
        } else expect(saved).toBeUndefined()
        reopened.close()
      } finally {
        for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
      }
    }
  })
  it('Set up service on a live server never removes a running session\'s bundle (a finish between its save and its kill)', async () => {
    const { manager, store } = fixture()
    const session = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    await store.saveBundle(session.id, makeBundle(await picture(), { rebuilds: {} }, 1))
    await manager.setupService(async () => {})
    expect(store.hasBundle(session.id)).toBe(true)
  })
  it('shutdown waits for a final save in flight before it closes the store', async () => {
    const { manager, finalCut, store, live } = fixture()
    const session = await manager.create({ title: 'Exits', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    live.delete(session.id)
    const refreshing = manager.refreshStates()
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    let closed = false
    const original = store.close.bind(store)
    store.close = () => { closed = true; original() }
    const stopping = manager.shutdown()
    await Bun.sleep(20)
    expect(closed).toBe(false)
    release(await picture())
    await refreshing
    await stopping
    expect(closed).toBe(true)
  })
  it('recording a failure that itself fails never stops the kill', async () => {
    const { manager, finals, store } = fixture()
    const session = await manager.create({ title: 'Ends', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    store.markOutput = () => { throw new Error('disk full') }
    const taken = await manager.control(session.id, human, 'take')
    expect((await manager.finish(session.id, human, taken.generation, true)).state).toBe('completed')
    expect(finals.at(-1)).toBe(`terminate ${session.id}`)
  })
  it('maintenance never completes an exited session while its final save is in flight (isolated creation runs it too)', async () => {
    const { manager, finalCut, live, terminated, advance } = fixture()
    const session = await manager.create({ title: 'Idle', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    live.delete(session.id)
    const refreshing = manager.refreshStates()
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    advance()
    await manager['run'](() => manager['sweepUnlocked']())
    expect(terminated).toEqual([])
    release(await picture())
    await refreshing
    await manager.sweep()
    expect(terminated).toEqual([session.id])
    expect(manager.get(session.id, human)).toMatchObject({ state: 'completed', outputSaved: true })
  })
  it('pane-died hints coalesce: one refresh, and one more if hints came during it', async () => {
    const { manager, paneDied } = fixture()
    const session = await manager.create({ title: 'Lives', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    // A hint is a hint: the pane is still alive, so every refresh checks it again.
    let checks = 0
    const original = manager['driver'].alive
    manager['driver'].alive = async (id: string) => { checks++; await Bun.sleep(2); return original(id) }
    for (let hint = 0; hint < 20; hint++) paneDied.get(session.id)!()
    // Absence cannot be polled for: time for every refresh the hints could cause to run.
    await Bun.sleep(60)
    expect(checks).toBe(2)
  })
  it('at startup, a running session with a bundle: alive, the bundle was provisional and goes; its pane dead, it was the final output and stays', async () => {
    for (const alive of [true, false]) {
      const { manager, store, live } = fixture()
      const session = await manager.create({ title: 'Crashed', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
      // Saved, then a crash before the kill (the record still says running).
      await store.saveBundle(session.id, makeBundle(await picture(), { rebuilds: {} }, 1))
      if (!alive) live.delete(session.id)
      await manager.start()
      expect(store.hasBundle(session.id)).toBe(!alive)
      expect(manager.get(session.id, human)).toMatchObject({ state: alive ? 'running' : 'exited', outputSaved: !alive })
    }
  })
  it('the save runs outside the manager queue: input to another session is not held behind it', async () => {
    const { manager, finalCut, writes } = fixture()
    const ending = await manager.create({ title: 'Ending', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    const other = await manager.create({ title: 'Other', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
    let release!: (cut: Cut | undefined) => void
    finalCut.next = () => new Promise((resolve) => { release = resolve })
    const taken = await manager.control(ending.id, human, 'take')
    const finishing = manager.finish(ending.id, human, taken.generation, true)
    for (let tries = 0; tries < 100 && !release; tries++) await Bun.sleep(1)
    const otherTaken = await manager.control(other.id, human, 'take')
    await manager.write(other.id, human, otherTaken.generation, otherTaken.inputSequence + 1, 'ls\r')
    expect(writes).toEqual(['ls\r'])
    release(await picture())
    expect((await finishing).state).toBe('completed')
  })
})

describe('the confirmed service update (applyServiceUpdate)', () => {
  const setups = () => {
    const ran: string[] = []
    return { ran, install: async () => { ran.push('setup') } }
  }
  test('ends exactly the confirmed live sessions, then sets up the service', async () => {
    const { manager, terminated } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    const two = await manager.create({ title: 'Two', cwd: '/tmp', program: 'shell' }, human)
    const { ran, install } = setups()
    expect(await manager.applyServiceUpdate([one.id, two.id], human, install, async () => true)).toEqual({ ended: ['One', 'Two'] })
    expect(terminated.sort()).toEqual([one.id, two.id].sort())
    expect(ran).toEqual(['setup'])
    expect(manager.store.sessions().every((session) => session.state === 'completed')).toBe(true)
  })
  test('ends nothing when no update is due any more (applied elsewhere)', async () => {
    const { manager, terminated } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    const { ran, install } = setups()
    await expect(manager.applyServiceUpdate([one.id], human, install, async () => false)).rejects.toThrow('already up to date; no sessions were ended')
    expect(terminated).toEqual([])
    expect(ran).toEqual([])
  })
  test('ends nothing when the live sessions are not the confirmed ones (one started, or one the operator never saw)', async () => {
    const { manager, terminated } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    const { ran, install } = setups()
    await manager.create({ title: 'Started meanwhile', cwd: '/tmp', program: 'shell' }, human)
    await expect(manager.applyServiceUpdate([one.id], human, install, async () => true)).rejects.toThrow('changed since you confirmed; no sessions were ended')
    await expect(manager.applyServiceUpdate([one.id, 'not-a-session', 'other'], human, install, async () => true)).rejects.toThrow('changed since you confirmed')
    expect(terminated).toEqual([])
    expect(ran).toEqual([])
  })
  test('a creation in flight is seen before anything ends; one asked for during the update is refused', async () => {
    const { manager, terminated, createHold } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    let release = () => {}
    createHold.until = new Promise<void>((resolve) => { release = resolve })
    const starting = manager.create({ title: 'Starting', cwd: '/tmp', program: 'shell' }, human)
    const { ran, install } = setups()
    const confirmed = manager.applyServiceUpdate([one.id], human, install, async () => true)
    release()
    createHold.until = undefined
    await starting
    await expect(confirmed).rejects.toThrow('changed since you confirmed; no sessions were ended')
    expect(terminated).toEqual([])
    expect(ran).toEqual([])
    // Confirmed again with both. A session asked for while the update runs never starts in between: it is
    // refused while sessions end, and waits behind setup (which holds the queue) once that has begun.
    let installed = () => {}
    let installing = false
    const holding = manager.applyServiceUpdate(manager.store.sessions().filter((session) => session.state === 'running').map((session) => session.id), human,
      () => new Promise<void>((resolve) => { installing = true; installed = resolve }), async () => true)
    for (let tries = 0; tries < 200 && !installing; tries++) await Bun.sleep(1)
    const late = manager.create({ title: 'Late', cwd: '/tmp', program: 'shell' }, human).then(() => 'started', (error: Error) => error.message)
    installed()
    expect((await holding).ended.sort()).toEqual(['One', 'Starting'])
    const outcome = await late
    expect(outcome === 'started' || outcome.includes('applying its service update')).toBe(true)
    // Done: sessions start again.
    await manager.create({ title: 'After', cwd: '/tmp', program: 'shell' }, human)
  })
  test('a session asked for while confirmed sessions are ending is refused', async () => {
    const { manager, createHold, terminated } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    void createHold
    const { install } = setups()
    const updating = manager.applyServiceUpdate([one.id], human, install, async () => true)
    // Queued right behind the update's check: it runs before the first kill's step.
    const refused = manager.create({ title: 'Too soon', cwd: '/tmp', program: 'shell' }, human)
    await expect(refused).rejects.toThrow('applying its service update')
    await updating
    expect(terminated).toEqual([one.id])
  })
  test('a session that cannot be ended stops it before setup, naming what did end', async () => {
    const { manager, unkillable } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    const two = await manager.create({ title: 'Two', cwd: '/tmp', program: 'shell' }, human)
    unkillable.add(two.id)
    const { ran, install } = setups()
    await expect(manager.applyServiceUpdate([one.id, two.id], human, install, async () => true)).rejects.toThrow('Ended One; Two could not be ended (kill-session failed). The update was not applied.')
    expect(ran).toEqual([])
  })
  test('a setup that fails after sessions ended says so', async () => {
    const { manager } = fixture()
    const one = await manager.create({ title: 'One', cwd: '/tmp', program: 'shell' }, human)
    const failing = async () => { throw new TerminalError('Could not bootstrap the Terminal LaunchAgent', 503) }
    await expect(manager.applyServiceUpdate([one.id], human, failing, async () => true)).rejects.toThrow('Ended One; the update was not applied: Could not bootstrap the Terminal LaunchAgent')
  })
})
