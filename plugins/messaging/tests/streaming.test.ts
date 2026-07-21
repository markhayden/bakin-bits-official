/**
 * Brainstorm turn tests (engine-backed, bakin#703) — 202 + bus events,
 * proposal extraction, plan refinement, segmented persistence, abort,
 * attention totals, and error handling.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const testDir = (() => {
  const { join } = require('path')
  const { tmpdir } = require('os')
  return join(tmpdir(), `bakin-test-streaming-${Date.now()}`)
})()

// ES imports are hoisted above mock.module — set env so the content-dir
// guard doesn't trip when plugin modules call getContentDir at init.
process.env.BAKIN_HOME = testDir
process.env.OPENCLAW_HOME = testDir + '-openclaw'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
}))

mock.module('../../../src/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({ messaging: testDir }),
}))

mock.module('../../../src/core/logger', () => ({
  createLogger: () => ({
    info: mock(), warn: mock(), error: mock(), debug: mock(),
  }),
}))

mock.module('../../../src/core/audit', () => ({ appendAudit: mock() }))
mock.module('../../../src/core/watcher', () => ({ watchDir: mock() }))
mock.module('@bakin/adapter-openclaw/home', () => ({
  getOpenClawPath: mock(() => '/tmp/mock-openclaw.json'),
  getOpenClawHome: mock(() => '/tmp/mock-openclaw'),
}))

;(globalThis as any).__bakinBroadcast = mock()

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const messagingPlugin = require('../../../plugins/messaging/index').default as typeof import('../../../plugins/messaging/index').default
import {
  activatePlugin,
  findRoute,
  findTool,
  callRoute,
  makeRequest,
} from '../test-helpers'
import type { ActivatedPlugin } from '../test-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RuntimeSend = ActivatedPlugin['ctx']['runtime']['messaging']['send']
type RuntimeStream = ActivatedPlugin['ctx']['runtime']['messaging']['stream']

let mockRuntimeSend = mock(async () => ({ id: 'runtime-msg', content: '' }))
let mockRuntimeStream = mock(() => streamRuntimeText(''))

async function* streamRuntimeText(content: string): AsyncIterable<{ type: 'text'; content: string }> {
  const words = content.split(/(\s+)/)
  for (const word of words) {
    if (!word) continue
    yield { type: 'text', content: word }
  }
}

async function* streamRuntimeChunks(
  chunks: Array<{ type: 'text' | 'tool' | 'status' | 'error'; content?: string; data?: unknown }>,
): AsyncIterable<{ type: 'text' | 'tool' | 'status' | 'error'; content?: string; data?: unknown }> {
  for (const chunk of chunks) yield chunk
}

function installRuntimeMessagingMocks(): void {
  plugin.ctx.runtime.messaging.send = mockRuntimeSend as RuntimeSend
  plugin.ctx.runtime.messaging.stream = mockRuntimeStream as RuntimeStream
}

function resetRuntimeMessagingMocks(): void {
  mockRuntimeSend = mock(async () => ({ id: 'runtime-msg', content: '' }))
  mockRuntimeStream = mock(() => streamRuntimeText(''))
  installRuntimeMessagingMocks()
}

function streamRuntimeResponse(content: string): void {
  mockRuntimeStream.mockImplementationOnce(() => streamRuntimeText(content))
}

function streamRuntimeChunkResponse(
  chunks: Array<{ type: 'text' | 'tool' | 'status' | 'error'; content?: string; data?: unknown }>,
): void {
  mockRuntimeStream.mockImplementationOnce(() => streamRuntimeChunks(chunks))
}

function sendRuntimeResponse(content: string): void {
  mockRuntimeSend.mockImplementationOnce(async () => ({ id: 'runtime-msg', content }))
}

function failRuntimeStream(error: Error): void {
  mockRuntimeStream.mockImplementationOnce(() => {
    throw error
  })
}

function failRuntimeSend(error: Error): void {
  mockRuntimeSend.mockImplementationOnce(async () => {
    throw error
  })
}

/** Record every messaging.brainstorm.* bus event during a turn. */
function collectBusEvents(): { events: Array<{ event: string; data: Record<string, unknown> }>; stop: () => void } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const off = plugin.ctx.events.on('*', (event, data) => {
    if (event.startsWith('messaging.brainstorm.')) events.push({ event, data })
  })
  return { events, stop: off }
}

/** Resolves when the in-flight turn settles (done or error bus event). */
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

/** Send + await turn settle; returns the collected bus events. */
async function sendAndSettle(sessionId: string, message: string, planId?: string): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const bus = collectBusEvents()
  const settled = nextSettle()
  const res = planId ? await sendPlanMessage(sessionId, planId, message) : await sendMessage(sessionId, message)
  if (res.status !== 202) throw new Error(`send failed: ${res.status} ${await res.text()}`)
  await settled
  bus.stop()
  return bus.events
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let plugin: ActivatedPlugin

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'messaging.json'), '[]')
  plugin = await activatePlugin(messagingPlugin, testDir)
  installRuntimeMessagingMocks()
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  const sessionsDir = join(testDir, 'messaging', 'sessions')
  if (existsSync(sessionsDir)) rmSync(sessionsDir, { recursive: true, force: true })
  writeFileSync(join(testDir, 'messaging.json'), '[]')
  mock.clearAllMocks()
  resetRuntimeMessagingMocks()
})

async function createTestSession(agentId = 'basil'): Promise<string> {
  const postRoute = findRoute(plugin.routes, 'POST', '/sessions')!
  const { body } = await callRoute(postRoute, plugin.ctx, {
    body: { agentId },
  })
  return (body.session as Record<string, unknown>).id as string
}

async function sendMessage(sessionId: string, message: string): Promise<Response> {
  const route = findRoute(plugin.routes, 'POST', '/sessions/:id/messages')!
  const req = makeRequest('/sessions/:id/messages', {
    method: 'POST',
    body: { message },
    searchParams: { id: sessionId },
  })
  return route.handler(req, plugin.ctx)
}

async function sendPlanMessage(sessionId: string, planId: string, message: string): Promise<Response> {
  const route = findRoute(plugin.routes, 'POST', '/sessions/:id/messages')!
  const req = makeRequest('/sessions/:id/messages', {
    method: 'POST',
    body: { message, planId },
    searchParams: { id: sessionId },
  })
  return route.handler(req, plugin.ctx)
}

async function createMaterializedPlan(sessionId: string): Promise<string> {
  streamRuntimeResponse(`Plan option:\n\`\`\`json\n{"title":"Trail safety Monday","targetDate":"2026-05-18","brief":"Beginner survival tip about leaving a trip plan."}\n\`\`\``)
  await sendAndSettle(sessionId, 'Plan one topic')

  const getSession = findRoute(plugin.routes, 'GET', '/sessions/:id')!
  const sessionResult = await callRoute(getSession, plugin.ctx, { searchParams: { id: sessionId } })
  const session = sessionResult.body.session as Record<string, unknown>
  const proposals = session.proposals as Array<Record<string, unknown>>
  const proposalId = proposals[0].id as string

  const updateProposal = findRoute(plugin.routes, 'PUT', '/sessions/:id/proposals/:proposalId')!
  await callRoute(updateProposal, plugin.ctx, {
    searchParams: { id: sessionId, proposalId },
    body: { status: 'approved' },
  })

  const materialize = findRoute(plugin.routes, 'POST', '/sessions/:id/materialize')!
  const result = await callRoute(materialize, plugin.ctx, { searchParams: { id: sessionId } })
  return (result.body.planIds as string[])[0]
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Brainstorm turns (engine-backed)', () => {
  it('202s immediately with the streaming flag', async () => {
    streamRuntimeResponse('Hello world')
    const sessionId = await createTestSession()
    const settled = nextSettle()
    const res = await sendMessage(sessionId, 'Plan next week')
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true, streaming: true })
    await settled
  })

  it('streams text chunks over the bus, keyed by session', async () => {
    streamRuntimeResponse('Here are some ideas for next week.')
    const sessionId = await createTestSession()
    const events = await sendAndSettle(sessionId, 'Plan next week')

    const textChunks = events.filter(e => e.event === 'messaging.brainstorm.chunk' && (e.data.chunk as { type: string }).type === 'text')
    expect(textChunks.length).toBeGreaterThan(0)
    for (const e of textChunks) expect(e.data.sessionId).toBe(sessionId)
    const fullText = textChunks.map(e => (e.data.chunk as { content?: string }).content).join('')
    expect(fullText).toContain('Here')
    expect(fullText).toContain('ideas')
    expect(events.some(e => e.event === 'messaging.brainstorm.done')).toBe(true)
  })

  it('forwards runtime tool chunks on the bus and stores structured activity rows interleaved with text', async () => {
    streamRuntimeChunkResponse([
      { type: 'text', content: 'Checking ' },
      {
        type: 'tool',
        content: 'exec: gh issue list',
        data: {
          phase: 'call',
          callId: 'call-1',
          toolName: 'exec',
          status: 'running',
          summary: 'gh issue list',
          inputPreview: '{"command":"gh issue list"}',
        },
      },
      {
        type: 'tool',
        content: 'exec completed',
        data: {
          phase: 'result',
          callId: 'call-1',
          toolName: 'exec',
          status: 'completed',
          durationMs: 6605,
          outputPreview: '[]',
        },
      },
      { type: 'text', content: 'done.' },
    ])
    const sessionId = await createTestSession()
    const events = await sendAndSettle(sessionId, 'Look up issues')

    // The bus carries the raw runtime chunks — the kit folds them client-side.
    const toolChunks = events.filter(e => e.event === 'messaging.brainstorm.chunk' && (e.data.chunk as { type: string }).type === 'tool')
    expect(toolChunks).toHaveLength(2)

    // Durable rows follow the turn recorder's interleaving: text flushed
    // before the tool RESULT (call phase folds into it), then trailing text.
    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    expect(session.messages).toMatchObject([
      { role: 'user', content: 'Look up issues' },
      { role: 'assistant', content: 'Checking' },
      { role: 'activity', kind: 'tool_call', content: 'exec: gh issue list', agentId: 'basil' },
      { role: 'assistant', content: 'done.' },
    ])
    const activityRow = session.messages[2]
    expect(activityRow.data).toMatchObject({ kind: 'tool', toolName: 'exec', status: 'completed', outputPreview: '[]' })
  })

  it('uses a stable runtime thread id across messages in the same session', async () => {
    streamRuntimeResponse('First answer.')
    streamRuntimeResponse('Second answer.')
    const sessionId = await createTestSession('nemo')

    await sendAndSettle(sessionId, 'First question')
    await sendAndSettle(sessionId, 'Second question')

    const threadIds = mockRuntimeStream.mock.calls.map((call) => call[0]?.threadId)
    expect(threadIds).toEqual([
      `messaging:${sessionId}:nemo`,
      `messaging:${sessionId}:nemo`,
    ])

    const secondPrompt = mockRuntimeStream.mock.calls[1]?.[0]?.content as string
    expect(secondPrompt).toContain('USER:\nSecond question')
    expect(secondPrompt).not.toContain('First question')
    expect(secondPrompt).not.toContain('First answer')
  })

  it('emits done with the reply preview after the turn settles', async () => {
    streamRuntimeResponse('All done.')
    const sessionId = await createTestSession()
    const events = await sendAndSettle(sessionId, 'quick')

    const doneEvents = events.filter(e => e.event === 'messaging.brainstorm.done')
    expect(doneEvents.length).toBe(1)
    expect(doneEvents[0].data).toMatchObject({ sessionId, preview: 'All done.' })
  })

  it('extracts proposals from JSON block and emits proposal bus events', async () => {
    const responseWithProposals = `Great ideas for next week!

\`\`\`json
[{"title":"Monday Recipe","targetDate":"2026-04-13","brief":"A quick pasta dish","suggestedChannels":["blog"]}]
\`\`\``

    streamRuntimeResponse(responseWithProposals)
    const sessionId = await createTestSession()
    const events = await sendAndSettle(sessionId, 'Plan next week')

    const proposalEvents = events.filter(e => e.event === 'messaging.brainstorm.proposal')
    expect(proposalEvents.length).toBe(1)
    const proposal = proposalEvents[0].data.proposal as Record<string, unknown>
    expect(proposal.title).toBe('Monday Recipe')
    expect(proposal.status).toBe('proposed')
  })

  it('applies Plan refinement JSON without creating new brainstorm proposals', async () => {
    const sessionId = await createTestSession()
    const planId = await createMaterializedPlan(sessionId)
    streamRuntimeResponse(`I'd use X for the short public take, Instagram for visual packaging, and TikTok for reach.\n\n\`\`\`json\n{"planUpdate":{"channels":[{"channel":"x"},{"channel":"instagram"},{"channel":"tiktok"}]}}\n\`\`\``)

    const events = await sendAndSettle(sessionId, 'what channels do you recommend?', planId)

    expect(events.filter(e => e.event === 'messaging.brainstorm.proposal')).toHaveLength(0)
    const planUpdateEvents = events.filter(e => e.event === 'messaging.brainstorm.plan_update')
    expect(planUpdateEvents).toHaveLength(1)
    const refinedPlan = planUpdateEvents[0].data.plan as Record<string, unknown>
    expect((refinedPlan.channels as Array<Record<string, unknown>>).map(channel => channel.channel)).toEqual(['x', 'instagram', 'tiktok'])
    expect((refinedPlan.channels as Array<Record<string, unknown>>).map(channel => channel.contentType)).toEqual(['x-post', 'image', 'video'])

    // Plan-refinement turns run on the plan's own thread.
    const lastCall = mockRuntimeStream.mock.calls.at(-1)?.[0]
    expect(lastCall?.threadId).toBe(`messaging-plan:${planId}:basil`)
    const prompt = lastCall?.content as string
    expect(prompt).toContain('Plan Refinement Mode')
    expect(prompt).toContain('Do not inspect Schedule, cron jobs, schedule runs')
    expect(prompt).toContain('USER:\nwhat channels do you recommend?')
    expect(prompt).not.toContain('Your job is to propose **content topics** as Plan proposals')

    const getPlan = findRoute(plugin.routes, 'GET', '/plans/:id')!
    const gotPlan = await callRoute(getPlan, plugin.ctx, { searchParams: { id: planId } })
    const storedPlan = gotPlan.body.plan as Record<string, unknown>
    expect((storedPlan.channels as Array<Record<string, unknown>>).map(channel => channel.channel)).toEqual(['x', 'instagram', 'tiktok'])
    expect((storedPlan.channels as Array<Record<string, unknown>>)[0].publishAt).toBe('2026-05-18T16:00:00Z')

    const getSession = findRoute(plugin.routes, 'GET', '/sessions/:id')!
    const gotSession = await callRoute(getSession, plugin.ctx, { searchParams: { id: sessionId } })
    const session = gotSession.body.session as Record<string, unknown>
    expect((session.proposals as unknown[]).length).toBe(1)
  })

  it('persists user and assistant messages to the session file', async () => {
    streamRuntimeResponse('Sounds good, let me think...')
    const sessionId = await createTestSession()
    await sendAndSettle(sessionId, 'Plan content for Monday')

    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    expect(existsSync(sessionPath)).toBe(true)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    expect(session.messages.length).toBe(2)
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[0].content).toBe('Plan content for Monday')
    expect(session.messages[1].role).toBe('assistant')
  })

  it('persists proposals to the session file', async () => {
    const responseWithProposals = `Ideas:\n\`\`\`json\n[{"title":"Test","targetDate":"2026-04-13","brief":"A tip","suggestedChannels":["x"]}]\n\`\`\``
    streamRuntimeResponse(responseWithProposals)
    const sessionId = await createTestSession()
    await sendAndSettle(sessionId, 'Suggest something')

    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    expect(session.proposals.length).toBe(1)
    expect(session.proposals[0].title).toBe('Test')
    expect(session.proposals[0].agentId).toBe('basil')
  })

  it('links proposals to their message via proposalIds', async () => {
    const responseWithProposals = `Here:\n\`\`\`json\n[{"title":"Linked","targetDate":"2026-04-13","brief":"A tip","suggestedChannels":["x"]}]\n\`\`\``
    streamRuntimeResponse(responseWithProposals)
    const sessionId = await createTestSession()
    await sendAndSettle(sessionId, 'Ideas')

    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    const assistantMsg = session.messages.find((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistantMsg.proposalIds).toBeDefined()
    expect(assistantMsg.proposalIds.length).toBe(1)
    expect(assistantMsg.proposalIds[0]).toBe(session.proposals[0].id)
  })

  it('a failing runtime stream settles as an error turn — durable error row + bus error event', async () => {
    failRuntimeStream(new Error('Stream failed'))

    const sessionId = await createTestSession()
    const bus = collectBusEvents()
    const settled = nextSettle()
    const res = await sendMessage(sessionId, 'Plan')
    expect(res.status).toBe(202)
    await settled
    bus.stop()

    const errorEvents = bus.events.filter(e => e.event === 'messaging.brainstorm.error')
    expect(errorEvents.length).toBe(1)
    expect(String(errorEvents[0].data.message)).toContain('Stream failed')

    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    const last = session.messages[session.messages.length - 1]
    expect(last).toMatchObject({ role: 'activity', kind: 'turn_error' })
    expect(last.content).toContain('Stream failed')
  })

  it('one turn per session: concurrent send 409s; abort settles clean with a marker row', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mockRuntimeStream.mockImplementationOnce(() => (async function* () {
      yield { type: 'text' as const, content: 'partial reply' }
      await gate
      yield { type: 'done' as const }
    })())

    const sessionId = await createTestSession()
    const settled = nextSettle()
    const first = await sendMessage(sessionId, 'go')
    expect(first.status).toBe(202)
    const second = await sendMessage(sessionId, 'again')
    expect(second.status).toBe(409)

    // Mid-turn, the session GET seeds the streaming flag.
    const getSession = findRoute(plugin.routes, 'GET', '/sessions/:id')!
    const midTurn = await callRoute(getSession, plugin.ctx, { searchParams: { id: sessionId } })
    expect(midTurn.body.streaming).toBe(true)

    const abortRoute = findRoute(plugin.routes, 'POST', '/sessions/:id/abort')!
    const aborted = await callRoute(abortRoute, plugin.ctx, { searchParams: { id: sessionId } })
    expect(aborted.status).toBe(200)
    release()
    await settled
    // The slot releases just after the done event — wait for idle before
    // asserting the idle-abort contract.
    for (let i = 0; i < 50; i++) {
      const check = await callRoute(getSession, plugin.ctx, { searchParams: { id: sessionId } })
      if (check.body.streaming === false) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    const roles = session.messages.map((m: { role: string; kind?: string }) => m.kind ?? m.role)
    expect(roles).toContain('turn_aborted')
    // The interrupted partial reply survives (bakin#703 — previously lost).
    expect(session.messages.some((m: { role: string; content: string }) => m.role === 'assistant' && m.content.includes('partial reply'))).toBe(true)

    const idle = await callRoute(abortRoute, plugin.ctx, { searchParams: { id: sessionId } })
    expect(idle.status).toBe(409)
  })

  it('attention totals: unread counts sessions with unseen agent activity; seen clears', async () => {
    streamRuntimeResponse('A reply.')
    const sessionId = await createTestSession()
    await sendAndSettle(sessionId, 'hi')

    const attentionRoute = findRoute(plugin.routes, 'GET', '/brainstorm/attention')!
    let res = await callRoute(attentionRoute, plugin.ctx, {})
    expect(res.body).toMatchObject({ unreadTotal: 1, inflight: [] })

    const seenRoute = findRoute(plugin.routes, 'POST', '/sessions/:id/seen')!
    const seen = await callRoute(seenRoute, plugin.ctx, { searchParams: { id: sessionId } })
    expect(seen.status).toBe(200)

    res = await callRoute(attentionRoute, plugin.ctx, {})
    expect(res.body).toMatchObject({ unreadTotal: 0, inflight: [] })

    const ghost = await callRoute(seenRoute, plugin.ctx, { searchParams: { id: 'ghost' } })
    expect(ghost.status).toBe(404)
  })

  it('returns JSON 400 for missing params (before the turn starts)', async () => {
    const route = findRoute(plugin.routes, 'POST', '/sessions/:id/messages')!
    const { status, body } = await callRoute(route, plugin.ctx, {
      searchParams: { id: 'some-id' },
      body: {},
    })
    expect(status).toBe(400)
    expect(body.error).toContain('message required')
  })

  it('returns JSON 404 for nonexistent session', async () => {
    const route = findRoute(plugin.routes, 'POST', '/sessions/:id/messages')!
    const { status } = await callRoute(route, plugin.ctx, {
      searchParams: { id: 'nonexistent' },
      body: { message: 'hello' },
    })
    expect(status).toBe(404)
  })

  it('strips JSON block from stored assistant message content', async () => {
    const responseWithJson = `Great plan!\n\`\`\`json\n[{"title":"X","targetDate":"2026-04-13","brief":"Y","suggestedChannels":["x"]}]\n\`\`\``
    streamRuntimeResponse(responseWithJson)
    const sessionId = await createTestSession()
    await sendAndSettle(sessionId, 'Plan')

    const sessionPath = join(testDir, 'messaging', 'sessions', `${sessionId}.json`)
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
    const assistantMsg = session.messages.find((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistantMsg.content).not.toContain('```json')
    expect(assistantMsg.content).toContain('Great plan!')
  })

  it('meters brainstorm turns under work class chat with the brainstorm runId scheme', async () => {
    streamRuntimeResponse('ok')
    plugin.meteredTurns.length = 0
    const sessionId = await createTestSession()
    await sendAndSettle(sessionId, 'hi')
    expect(plugin.meteredTurns).toHaveLength(1)
    expect(String(plugin.meteredTurns[0].runId)).toStartWith(`brainstorm:messaging:${sessionId}:turn:`)
    expect(plugin.meteredTurns[0].workClass).toBe('chat')
  })
})

describe('Session message exec tool (non-streaming)', () => {
  it('calls runtime non-streaming and returns response', async () => {
    sendRuntimeResponse('Here are my ideas for you.')

    const createTool = findTool(plugin.execTools, 'bakin_exec_messaging_session_create')!
    const created = await createTool.handler({ agentId: 'basil' }, 'test')
    const sessionId = (created.session as Record<string, unknown>).id as string

    const tool = findTool(plugin.execTools, 'bakin_exec_messaging_session_message')!
    const result = await tool.handler({ sessionId, message: 'Plan next week' }, 'test')

    expect(result.ok).toBe(true)
    expect(result.response).toBe('Here are my ideas for you.')
    expect(result.messageId).toBeDefined()
    expect(mockRuntimeSend).toHaveBeenCalled()
  })

  it('uses a stable runtime thread id for non-streaming session messages', async () => {
    sendRuntimeResponse('First response.')
    sendRuntimeResponse('Second response.')

    const createTool = findTool(plugin.execTools, 'bakin_exec_messaging_session_create')!
    const created = await createTool.handler({ agentId: 'basil' }, 'test')
    const sessionId = (created.session as Record<string, unknown>).id as string

    const tool = findTool(plugin.execTools, 'bakin_exec_messaging_session_message')!
    await tool.handler({ sessionId, message: 'First' }, 'test')
    await tool.handler({ sessionId, message: 'Second' }, 'test')

    const threadIds = mockRuntimeSend.mock.calls.map((call) => call[0]?.threadId)
    expect(threadIds).toEqual([
      `messaging:${sessionId}:basil`,
      `messaging:${sessionId}:basil`,
    ])
    const secondPrompt = mockRuntimeSend.mock.calls[1]?.[0]?.content as string
    expect(secondPrompt).toContain('USER:\nSecond')
    expect(secondPrompt).not.toContain('First response')
  })

  it('returns error when runtime completion fails', async () => {
    failRuntimeSend(new Error('Runtime down'))

    const createTool = findTool(plugin.execTools, 'bakin_exec_messaging_session_create')!
    const created = await createTool.handler({ agentId: 'basil' }, 'test')
    const sessionId = (created.session as Record<string, unknown>).id as string

    const tool = findTool(plugin.execTools, 'bakin_exec_messaging_session_message')!
    const result = await tool.handler({ sessionId, message: 'Plan' }, 'test')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Runtime down')
  })
})
