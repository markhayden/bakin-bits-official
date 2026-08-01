/**
 * Messaging — conversation consolidation backlog (bakin#706):
 * session message cap, mtime-cached session reads, the interrupted-turn
 * boot sweep, and the mid-turn streamed-text preview.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const testDir = (() => {
  const { join } = require('path')
  const { tmpdir } = require('os')
  return join(tmpdir(), `bakin-test-messaging-706-${Date.now()}`)
})()

// ES imports are hoisted above mock.module — set env so the content-dir
// guard doesn't trip when plugin modules call getContentDir at init.
process.env.BAKIN_HOME = testDir
process.env.OPENCLAW_HOME = testDir + '-openclaw'

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
}))
mock.module('@bakin/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({ messaging: testDir }),
}))

;(globalThis as any).__bakinBroadcast = mock()

// Dynamic require — defers the plugin load until after mocks are set.
const messagingPlugin = require('../../../plugins/messaging/index').default as typeof import('../../../plugins/messaging/index').default
import { activatePlugin, findRoute, callRoute, makeRequest, MarkdownStorageAdapter } from '../test-helpers'
import type { ActivatedPlugin } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'
import type { SessionMessage } from '../types'

let plugin: ActivatedPlugin

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'messaging.json'), '[]')
  plugin = await activatePlugin(messagingPlugin, testDir)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  const sessionsDir = join(testDir, 'messaging', 'sessions')
  if (existsSync(sessionsDir)) rmSync(sessionsDir, { recursive: true, force: true })
  writeFileSync(join(testDir, 'messaging.json'), '[]')
})

function sessionRow(role: 'user' | 'assistant', content: string, i: number): SessionMessage {
  return { id: `m${i}`, role, content, timestamp: new Date(i).toISOString() }
}

async function* streamText(tokens: string[]): AsyncIterable<{ type: 'text'; content: string }> {
  for (const token of tokens) yield { type: 'text', content: token }
}

function nextSettle(): Promise<void> {
  return new Promise((resolve) => {
    const off = plugin.ctx.events.on('*', (event) => {
      if (event === 'messaging.brainstorm.done' || event === 'messaging.brainstorm.error') {
        off()
        resolve()
      }
    })
  })
}

async function createSession(agentId = 'basil'): Promise<string> {
  const postRoute = findRoute(plugin.routes, 'POST', '/sessions')!
  const { body } = await callRoute(postRoute, plugin.ctx, { body: { agentId } })
  return (body.session as Record<string, unknown>).id as string
}

async function getSession(id: string): Promise<Record<string, unknown>> {
  const route = findRoute(plugin.routes, 'GET', '/sessions/:id')!
  const req = makeRequest('/sessions/:id', { searchParams: { id } })
  const res = await route.handler(req, plugin.ctx)
  return await res.json() as Record<string, unknown>
}

describe('session message cap', () => {
  it('appendBrainstormMessage drops the oldest rows past 300', async () => {
    const sessionId = await createSession()
    const store = createMessagingContentStorage(new MarkdownStorageAdapter(testDir))
    store.updateBrainstormSession(sessionId, {
      messages: Array.from({ length: 300 }, (_, i) => sessionRow(i % 2 ? 'assistant' : 'user', `row ${i}`, i)),
    })

    plugin.ctx.runtime.messaging.stream = mock(() => streamText(['capped reply'])) as typeof plugin.ctx.runtime.messaging.stream
    const settled = nextSettle()
    const route = findRoute(plugin.routes, 'POST', '/sessions/:id/messages')!
    const res = await route.handler(
      makeRequest('/sessions/:id/messages', { method: 'POST', body: { message: 'one more' }, searchParams: { id: sessionId } }),
      plugin.ctx,
    )
    expect(res.status).toBe(202)
    await settled

    const body = await getSession(sessionId)
    const messages = (body.session as { messages: SessionMessage[] }).messages
    expect(messages.length).toBeLessThanOrEqual(300)
    // Newest rows survive; oldest were dropped.
    expect(messages[messages.length - 1].content).toBe('capped reply')
    expect(messages[messages.length - 2].content).toBe('one more')
    expect(messages[0].content).not.toBe('row 0')
  })
})

describe('mtime-cached session reads', () => {
  it('returns the cached parse for an unchanged file and invalidates on write', () => {
    const store = createMessagingContentStorage(new MarkdownStorageAdapter(testDir))
    const session = store.createBrainstormSession({ agentId: 'basil', title: 'Cache probe' })
    const first = store.getBrainstormSession(session.id)
    const second = store.getBrainstormSession(session.id)
    // Same object identity — the second read came from the cache.
    expect(second).toBe(first)
    store.updateBrainstormSession(session.id, { title: 'Renamed' })
    const third = store.getBrainstormSession(session.id)
    expect(third).not.toBe(first)
    expect(third?.title).toBe('Renamed')
    store.deleteBrainstormSession(session.id)
    expect(store.getBrainstormSession(session.id)).toBeNull()
  })
})

describe('interrupted-turn boot sweep', () => {
  it('stamps a turn_error activity row on sessions that end on a user row', async () => {
    const store = createMessagingContentStorage(new MarkdownStorageAdapter(testDir))
    const interrupted = store.createBrainstormSession({ agentId: 'basil', title: 'Interrupted' })
    store.updateBrainstormSession(interrupted.id, { messages: [sessionRow('user', 'are you there?', 0)] })
    const settled = store.createBrainstormSession({ agentId: 'basil', title: 'Settled' })
    store.updateBrainstormSession(settled.id, { messages: [sessionRow('user', 'hi', 0), sessionRow('assistant', 'hello', 1)] })

    // The sweep runs during activate — re-activate over the fixtures.
    plugin = await activatePlugin(messagingPlugin, testDir)

    const sweptRows = store.getBrainstormSession(interrupted.id)!.messages
    expect(sweptRows.length).toBe(2)
    expect(sweptRows[1]).toMatchObject({
      role: 'activity',
      kind: 'turn_error',
      content: 'Turn failed: interrupted by a server restart before the reply finished.',
    })
    expect(store.getBrainstormSession(settled.id)!.messages.length).toBe(2)

    // Idempotent: a second activate doesn't stack more rows.
    plugin = await activatePlugin(messagingPlugin, testDir)
    expect(store.getBrainstormSession(interrupted.id)!.messages.length).toBe(2)
  })
})

describe('mid-turn streamed-text preview', () => {
  it('GET /sessions/:id carries streamingText while a turn is in flight, and drops it after', async () => {
    const sessionId = await createSession()
    let releaseTurn!: () => void
    const gate = new Promise<void>((resolve) => { releaseTurn = resolve })
    plugin.ctx.runtime.messaging.stream = mock(() => (async function* (): AsyncIterable<{ type: 'text'; content: string }> {
      yield { type: 'text', content: 'Working on ' }
      await gate
      yield { type: 'text', content: 'it.' }
    })()) as typeof plugin.ctx.runtime.messaging.stream

    const settled = nextSettle()
    const route = findRoute(plugin.routes, 'POST', '/sessions/:id/messages')!
    const res = await route.handler(
      makeRequest('/sessions/:id/messages', { method: 'POST', body: { message: 'go' }, searchParams: { id: sessionId } }),
      plugin.ctx,
    )
    expect(res.status).toBe(202)

    let midTurn: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      midTurn = await getSession(sessionId)
      if (midTurn.streamingText === 'Working on ') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(midTurn.streaming).toBe(true)
    expect(midTurn.streamingText).toBe('Working on ')

    releaseTurn()
    await settled
    // The done event lands before the engine releases the slot — poll until
    // the in-flight registration is gone.
    let after: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      after = await getSession(sessionId)
      if (after.streaming === false) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(after.streaming).toBe(false)
    expect('streamingText' in after).toBe(false)
  })
})
