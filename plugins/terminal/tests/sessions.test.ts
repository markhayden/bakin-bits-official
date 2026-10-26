import { afterEach, expect, test } from 'bun:test'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { DAY, type Session } from '../lib/contracts'
import type { NativeClient, ProcessDriver } from '../lib/processes'

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
  let writeFailure: Error | undefined
  let resizeFailure: Error | undefined
  let readBackFailure: Error | undefined
  const tmuxSizes = new Map<string, { cols: number; rows: number }>()
  const outputs = new Map<string, (data: Uint8Array) => void>()
  /** Terminal apps attached in tmux, per session, and each session's "clients changed" signal. */
  const natives = new Map<string, NativeClient[]>()
  const clientsChanged = new Map<string, () => void>()
  const vanishing = new Set<number>()
  const detachedClients: string[] = []
  const driver: ProcessDriver = {
    create: async (s) => { live.add(s.id); tmuxSizes.set(s.id, { cols: s.cols, rows: s.rows }) }, attach(s, output, changed) { attached.add(s.id); outputs.set(s.id, output); clientsChanged.set(s.id, changed) }, connected: (id) => attached.has(id),
    write: async (_id, data) => { if (writeFailure) throw writeFailure; writes.push(data) },
    resize: async (id, cols, rows) => { if (resizeFailure) { tmuxSizes.set(id, { cols: 77, rows: 22 }); throw resizeFailure } tmuxSizes.set(id, { cols, rows }) },
    windowSize: async (id) => { if (readBackFailure) throw readBackFailure; return tmuxSizes.get(id)! },
    title: async () => {}, alive: async (id) => live.has(id), screen: async () => '',
    terminate: async (id) => { terminated.push(id); live.delete(id) }, inUse: async () => false, detach: async (id) => { if (id) attached.delete(id); else attached.clear() },
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
  }
  const releases: Array<{ sessionId: string; worktreePath: string; teardown?: boolean }> = []
  const manager = new Sessions(new Store(':memory:'), driver, {
    settings: () => ({ enabledAgents: enabled }), now: () => now,
    prepare: async () => ({ ok: false }),
    release: async (input) => { releases.push(input); return releasable ? { ok: true } : { ok: false, error: 'Unmerged work' } },
  })
  managers.push(manager)
  return {
    manager, writes, live, attached, terminated, releases, outputs, natives, detachedClients, vanishing,
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
test('delete always removes the session — a retained worktree tears down, never blocks', async () => {
  const { manager, live, releases } = fixture()
  const session = await manager.create({ title: 'Done', cwd: '/tmp' }, agent)
  await expect(manager.deleteSession(session.id, human)).rejects.toThrow('End the session')
  session.worktreePath = '/tmp/retained'
  manager.store.save(session)
  live.delete(session.id)
  await manager.finish(session.id, agent, 1, false)
  manager.store.append(session.id, Buffer.from('history'))
  await expect(manager.deleteSession(session.id, agent)).rejects.toThrow('human')
  // The fixture release fails ("Unmerged work"), yet the session is gone: the
  // worktree teardown is best-effort and never blocks removing the record.
  await manager.deleteSession(session.id, human)
  // The safe clean at finish ran without teardown; the delete forces it.
  expect(releases.at(-1)).toEqual({ sessionId: session.id, worktreePath: '/tmp/retained', teardown: true })
  expect(releases.some((r) => !r.teardown)).toBe(true)
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

test('output subscribers hear each parsed chunk once it is stored, and can unsubscribe', async () => {
  const { manager, outputs } = fixture()
  const session = await manager.create({ title: 'Live', cwd: '/tmp', program: 'shell' }, human)
  const heard: number[] = []
  const unsubscribe = manager.onOutput(session.id, () => { heard.push(manager.output(session.id, human, 0).cursor) })
  outputs.get(session.id)!(new TextEncoder().encode('hello'))
  for (let attempt = 0; attempt < 50 && heard.length === 0; attempt++) await Bun.sleep(5)
  expect(heard).toEqual([1])
  unsubscribe()
  outputs.get(session.id)!(new TextEncoder().encode(' again'))
  await Bun.sleep(30)
  expect(heard).toEqual([1])
})

test('a failed delivery surfaces and still consumes the sequence (never retried)', async () => {
  const { manager, failWrites } = fixture()
  const session = await manager.create({ title: 'Input', cwd: '/tmp', program: 'shell' }, human)
  failWrites(new Error('Terminal control connection closed'))
  await expect(manager.write(session.id, human, session.generation, 1, 'ls\r')).rejects.toThrow('control connection closed')
  await expect(manager.write(session.id, human, session.generation, 1, 'ls\r')).rejects.toThrow('sequence')
})

test('nextOutput resolves on new output, on output that landed before it subscribed, and on abort', async () => {
  const { manager, outputs } = fixture()
  const session = await manager.create({ title: 'Wait', cwd: '/tmp', program: 'shell' }, human)
  const controller = new AbortController()
  const waiting = manager.nextOutput(session.id, manager.latestCursor(session.id), controller.signal, 5000)
  outputs.get(session.id)!(new TextEncoder().encode('x'))
  await waiting
  expect(manager.latestCursor(session.id)).toBe(1)
  // Output already past the cursor resolves at once.
  await manager.nextOutput(session.id, 0, controller.signal, 5000)
  const aborted = manager.nextOutput(session.id, manager.latestCursor(session.id), controller.signal, 5000)
  controller.abort()
  await aborted
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
  await manager.readScreen(session.id, human)
  failResizes(new Error('resize-window failed'))
  failReadBack(new Error('tmux unreachable'))
  await expect(manager.resizeAs(session.id, human, session.sizeEpoch, 120, 40)).rejects.toThrow('reconnect required')
  expect(attached.has(session.id)).toBe(false)
  await expect(manager.writeNext(session.id, human, session.generation, 'ls\r')).rejects.toThrow('reconnect required')
  expect(manager.get(session.id, human).inputSequence).toBe(0)
  expect(writes).toEqual([])
  // tmux moved after all; the next viewer sync reattaches and adopts its real window.
  failResizes(undefined)
  failReadBack(undefined)
  tmuxSizes.set(session.id, { cols: 77, rows: 22 })
  const screen = await manager.readScreen(session.id, human)
  expect([screen.cols, screen.rows]).toEqual([77, 22])
  expect(manager.get(session.id, human).sizeRevision).toBe(1)
})

test('a record that fails to save after tmux resized is reconciled from tmux on the next attachment', async () => {
  const { manager, attached, tmuxSizes } = fixture()
  const session = await manager.create({ title: 'Disk', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  await manager.readScreen(session.id, human)
  const save = manager.store.save.bind(manager.store)
  let failing = true
  manager.store.save = (next) => { if (failing) throw new Error('disk full'); save(next) }
  await expect(manager.resizeAs(session.id, human, session.sizeEpoch, 120, 40)).rejects.toThrow('reconnect required')
  expect(tmuxSizes.get(session.id)).toEqual({ cols: 120, rows: 40 })
  expect(attached.has(session.id)).toBe(false)
  failing = false
  const screen = await manager.readScreen(session.id, human)
  expect([screen.cols, screen.rows]).toEqual([120, 40])
  expect(manager.store.sessions().find((stored) => stored.id === session.id)).toMatchObject({ cols: 120, rows: 40 })
})

test('reattaching after setup adopts tmux\'s window, even when the stored record is stale', async () => {
  const { manager, tmuxSizes, live } = fixture()
  const session = await manager.create({ title: 'Restart', cwd: '/tmp', program: 'shell' }, human, { cols: 64, rows: 20, kind: 'browser', device: 'desktop' })
  // tmux moved, but the record never heard (a save that failed before a restart).
  tmuxSizes.set(session.id, { cols: 120, rows: 40 })
  live.add(session.id)
  await manager.setupService(async () => {})
  const screen = await manager.readScreen(session.id, human)
  expect([screen.cols, screen.rows]).toEqual([120, 40])
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
  const driver = { create: async () => {}, attach() {}, connected: () => true, write: async () => {}, resize: async () => {}, windowSize: async () => ({ cols: 200, rows: 60 }), title: async () => {}, alive: async () => true, screen: async () => '', terminate: async () => {}, inUse: async () => false, detach: async () => {}, clients: async () => [], detachClient: async () => {}, setReadonly: async () => {}, attachArgs: () => [] } satisfies ProcessDriver
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
