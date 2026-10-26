/**
 * The shared test context mirrors the host contracts Projects' steward relies
 * on (bakin P3a): one tasks.statusChanged per real column change, out-of-turn
 * appends that queue behind a running turn, and ctx.approvals' namespacing +
 * resolve rules. A drift here would let plugin tests pass against behavior
 * production does not have.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RuntimeChatChunk } from '@makinbakin/sdk/types'
import { createTestContext } from './test-helpers'

const testDir = join(tmpdir(), `bits-test-helpers-${Date.now()}`)
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('task store parity', () => {
  it('fires tasks.statusChanged once per column change, never for column-preserving writes', async () => {
    const { ctx } = createTestContext('projects', join(testDir, 'tasks'))
    const changes: Array<Record<string, unknown>> = []
    ctx.hooks.register('tasks.statusChanged', data => { changes.push(data as Record<string, unknown>) })
    const task = await ctx.tasks.create({ title: 'Work', tags: ['project-steward'] })
    expect(task.tags).toEqual(['project-steward'])
    await ctx.tasks.update(task.id, { title: 'Renamed' })
    await ctx.tasks.move(task.id, 'review')
    await ctx.tasks.update(task.id, { checked: true })
    await flush()
    expect(changes.map(c => [c.from, c.to])).toEqual([['todo', 'review'], ['review', 'done']])
    expect((await ctx.tasks.get(task.id))?.checked).toBe(true)
    await expect(ctx.tasks.create({ id: task.id, title: 'dup' })).rejects.toThrow('already exists')
  })
})

describe('appendExternal parity', () => {
  it('appends at once when idle and queues behind a running turn until it settles', async () => {
    const { ctx } = createTestContext('projects', join(testDir, 'turns'))
    const rows: Array<Record<string, unknown>> = []
    const appended: Array<Record<string, unknown>> = []
    ctx.events.on('t.appended', (_e, data) => { appended.push(data) })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ctx.runtime.messaging.stream = (async function* (): AsyncIterable<RuntimeChatChunk> {
      await gate
      yield { type: 'text', content: 'hi' }
      yield { type: 'done' }
    }) as typeof ctx.runtime.messaging.stream
    const service = ctx.conversations.createTurnService({
      name: 't',
      events: { chunk: 't.chunk', done: 't.done', error: 't.error', appended: 't.appended' },
      payload: key => ({ key }),
      resolveThread: () => ({ agentId: 'main' }),
      appendRow: (_key, row) => { rows.push(row as Record<string, unknown>) },
      threadId: key => key,
    })
    const turnCtx = { runtime: ctx.runtime, events: ctx.events }
    const checkin = { kind: 'assistant' as const, ts: 'now', turnId: 'steward:t1', agentId: 'main', content: 'Checked in' }

    const idle = await service.appendExternal(turnCtx, 'p1', [checkin], { agentId: 'main', preview: 'Checked in' })
    expect(idle.status).toBe('appended')
    expect(appended).toEqual([{ key: 'p1', notice: { agentId: 'main', preview: 'Checked in' } }])

    expect(await service.start(turnCtx, 'p1', 'hello')).toBe('accepted')
    const queued = await service.appendExternal(turnCtx, 'p1', [{ ...checkin, content: 'Later' }])
    expect(queued.status).toBe('queued')
    expect(rows.some(r => r.content === 'Later')).toBe(false)
    release()
    await queued.written
    const kinds = rows.map(r => r.content ?? r.kind)
    expect(kinds.indexOf('Later')).toBeGreaterThan(kinds.indexOf('hi'))
    expect(appended).toHaveLength(2)
  })
})

describe('ctx.approvals parity', () => {
  it('namespaces ids, keeps an existing id untouched, and resolves through the gate', async () => {
    const { ctx, approvals } = createTestContext('projects', join(testDir, 'approvals'))
    const decisions: string[] = []
    ctx.approvals.registerGate('complete', {
      ownerState: () => 'live',
      onResolve: (_approval, decision) => { decisions.push(decision.option) },
    })
    const input = { approvalId: 'projects:p1:complete:project:1', gateKind: 'complete', entityId: 'p1', taskId: 't1', title: 'Complete?', summary: 'All done' }
    expect(() => ctx.approvals.request({ ...input, approvalId: 'other:p1' })).toThrow('must start with "projects:"')
    const first = ctx.approvals.request(input)
    expect(ctx.approvals.request({ ...input, title: 'Changed' }).title).toBe(first.title)
    await expect(approvals.resolve(first.approvalId, 'reject')).rejects.toThrow('reject reason')
    await expect(approvals.resolve(first.approvalId, 'maybe')).rejects.toThrow('not an option')
    const approved = await approvals.resolve(first.approvalId, 'approve')
    expect(approved.status).toBe('approved')
    expect(decisions).toEqual(['approve'])
    expect(ctx.approvals.listPending({ entityId: 'p1' })).toEqual([])
  })
})
