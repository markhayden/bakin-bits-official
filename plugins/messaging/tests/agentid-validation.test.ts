/**
 * Regression guard for the agentId path-traversal primitive closed in #122.
 *
 * /brainstorm previously read `team/personas/${body.agentId}.md` without
 * validating the id, so a body like {agentId: "../../etc/passwd"} walked
 * outside ~/.bakin/team/personas/. This suite locks in the validation:
 *
 *   - Shape guard /^[a-z0-9-]+$/ blocks traversal primitives (load-bearing).
 *   - team.getAgentIds roster check rejects orphan refs (defense-in-depth).
 *   - When the team plugin is unavailable / returns undefined, the shape
 *     guard alone suffices and messaging stays functional.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = join(tmpdir(), `bakin-test-agentid-${Date.now()}`)

process.env.BAKIN_HOME = testDir
process.env.OPENCLAW_HOME = testDir + '-openclaw'

// ---------------------------------------------------------------------------
// Mocks — must precede any plugin imports
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
mock.module('../../../packages/core/src/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({ messaging: testDir }),
}))

mock.module('../../../src/core/logger', () => ({
  createLogger: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }),
}))

mock.module('../../../src/core/audit', () => ({
  appendAudit: mock(),
}))

mock.module('../../../src/core/openclaw-client', () => ({
  sendMessage: mock(),
  sendChannelMessage: mock(),
  streamMessage: mock(),
  chatCompletion: mock(async () => 'Here are three ideas.\n```json\n[]\n```'),
}))

// Gateway token always present so /brainstorm can reach the fetch stub below.
mock.module('../../../src/core/vault', () => ({
  initialize: mock(),
  get: mock((key: string) => (key === 'gateway-token' ? 'test-token' : undefined)),
  has: mock(() => true),
  set: mock(),
  listKeys: mock(() => []),
  createPluginVault: mock(() => ({ get: mock(), set: mock(), has: mock(() => false) })),
}))

// Settings module supplies gateway URL/port for the /brainstorm fetch.
mock.module('../../../src/core/settings', () => ({
  getSettings: () => ({
    openclaw: { gatewayUrl: 'http://localhost', gatewayPort: 18789 },
  }),
}))

// Suppress SSE broadcast side effects.
;(globalThis as unknown as { __bakinBroadcast?: unknown }).__bakinBroadcast = mock()

// Stub the gateway chat-completions fetch with a canned response so the
// happy path returns 200 without a real gateway. All /brainstorm requests
// under test hit this single endpoint.
const originalFetch = globalThis.fetch
const fakeGatewayResponse = {
  choices: [{ message: { content: 'Here are three ideas.\n```json\n[]\n```' } }],
}
globalThis.fetch = (async () =>
  new Response(JSON.stringify(fakeGatewayResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const messagingPlugin = require('../../../plugins/messaging/index').default as typeof import('../../../plugins/messaging/index').default
import { activatePlugin, findRoute, callRoute } from '../test-helpers'
import type { ActivatedPlugin } from '../test-helpers'
import type { APIRoute } from '@bakin/core/plugin-types'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let plugin: ActivatedPlugin
let brainstormRoute: APIRoute

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true })
  mkdirSync(join(testDir, 'team', 'personas'), { recursive: true })
  writeFileSync(join(testDir, 'team', 'personas', 'basil.md'), '# Basil\nA chef who loves fresh ingredients.')

  plugin = await activatePlugin(messagingPlugin, testDir)
  brainstormRoute = findRoute(plugin.routes, 'POST', '/brainstorm')!
  expect(brainstormRoute).toBeDefined()
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  globalThis.fetch = originalFetch
})

/**
 * Install a specific hooks.invoke handler for this test.
 * Returns the replaced function so tests can restore it if needed.
 */
function setHookInvoke(impl: (name: string, data: unknown) => Promise<unknown>) {
  plugin.ctx.hooks.invoke = impl as typeof plugin.ctx.hooks.invoke
}

function rosterOf(ids: string[]) {
  return async (name: string, _data: unknown) => {
    if (name === 'team.getAgentIds') return ids
    if (name === 'team.getAgent') return null
    return undefined
  }
}

beforeEach(() => {
  mock.clearAllMocks()
  // Default: roster of just 'basil'. Individual tests override as needed.
  setHookInvoke(rosterOf(['basil']))
})

// ---------------------------------------------------------------------------
// Traversal primitives — shape guard must reject, no FS read
// ---------------------------------------------------------------------------

describe('/brainstorm — shape guard (path traversal)', () => {
  const traversalIds = [
    ['relative-parent', '../evil'],
    ['deep-parent', '../../../etc/passwd'],
    ['absolute-path', '/etc/passwd'],
    ['backslash', '..\\evil'],
    ['url-encoded', '..%2Fevil'],
    ['null-byte', 'agent\0id'],
    ['unicode-emoji', 'agent\u{1f6a8}'],
    ['uppercase', 'Basil'], // intentional — regex is lowercase-only
    ['dot-segment', 'agent.id'],
    ['space', 'agent id'],
  ]

  for (const [label, bad] of traversalIds) {
    it(`rejects ${label} agentId (${JSON.stringify(bad)}) with 400`, async () => {
      const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
        body: { agentId: bad, message: 'hi' },
      })
      expect(status).toBe(400)
      expect(body.error).toBe('invalid agentId')
    })
  }
})

// ---------------------------------------------------------------------------
// Orphan refs — shape-valid but not in roster
// ---------------------------------------------------------------------------

describe('/brainstorm — roster check (orphan refs)', () => {
  it('rejects a shape-valid agentId not present in the roster', async () => {
    setHookInvoke(rosterOf(['basil'])) // ghost is not in the list
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: 'ghost', message: 'hi' },
    })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid agentId')
  })

  it('accepts any shape-valid id when the roster is empty (no agents configured)', async () => {
    setHookInvoke(rosterOf([]))
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: 'basil', message: 'hi' },
    })
    // Shape-guard-alone path: empty roster means we can't disprove the id is
    // real, so we pass through to the handler's downstream.
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Degraded mode — team hook unavailable or throws
// ---------------------------------------------------------------------------

describe('/brainstorm — degraded mode (shape guard alone)', () => {
  it('accepts a shape-valid agentId when team.getAgentIds returns undefined', async () => {
    setHookInvoke(async () => undefined)
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: 'basil', message: 'hi' },
    })
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
  })

  it('accepts a shape-valid agentId when team.getAgentIds throws', async () => {
    setHookInvoke(async () => {
      throw new Error('team plugin offline')
    })
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: 'basil', message: 'hi' },
    })
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
  })

  it('still rejects a shape-invalid agentId even when team hook throws', async () => {
    setHookInvoke(async () => {
      throw new Error('team plugin offline')
    })
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: '../evil', message: 'hi' },
    })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid agentId')
  })
})

// ---------------------------------------------------------------------------
// Happy path — real agent in roster, persona file present
// ---------------------------------------------------------------------------

describe('/brainstorm — happy path', () => {
  it('returns 200 for a live agent id with a persona file on disk', async () => {
    setHookInvoke(rosterOf(['basil']))
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: 'basil', message: 'plan me a post' },
    })
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    expect(typeof body.response).toBe('string')
  })

  it('returns 200 for a live agent with no persona file on disk', async () => {
    setHookInvoke(rosterOf(['basil', 'scout']))
    const { status, body } = await callRoute(brainstormRoute, plugin.ctx, {
      body: { agentId: 'scout', message: 'plan me a post' },
    })
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
  })
})
