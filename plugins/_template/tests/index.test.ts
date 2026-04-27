/**
 * Smoke test for the _template plugin.
 *
 * Activates the plugin against a hand-rolled minimal PluginContext,
 * then asserts the route + health check land on the registered state.
 * This is the shape every plugin's tests should follow — exercise
 * activate/onShutdown without spinning up a real Bakin server.
 *
 * Defensive isolation: mirrors the bakin core test convention so this
 * file can never accidentally touch `~/.bakin/` or `~/.openclaw/` if a
 * future plugin developer copies it as a starting point. The plugin
 * itself has no fs writes, but copy-paste authoring will eventually
 * grow into one that does, and the mocks should already be in place.
 */
import { describe, it, expect, mock } from 'bun:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const testDir = join(tmpdir(), `bakin-bits-template-test-${Date.now()}-${randomUUID()}`)
process.env.BAKIN_HOME = testDir
process.env.OPENCLAW_HOME = join(testDir, 'openclaw')

// Bakin core internals — bakin-bits-official itself never imports these,
// but a misbehaving plugin under test could pull them in transitively.
// Stubbing them defensively keeps tests hermetic by construction.
mock.module('@/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({}),
}))
mock.module('@bakin/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({}),
}))
mock.module('@bakin/core/openclaw-home', () => ({
  getOpenClawHome: () => join(testDir, 'openclaw'),
  getOpenClawPath: (...parts: string[]) => join(testDir, 'openclaw', ...parts),
  resetOpenClawHome: () => {},
}))

import plugin from '../index'

interface RegisteredRoute {
  method: string
  path: string
  handler: (req: Request) => Promise<Response>
}

interface RegisteredHealthCheck {
  id: string
  run: () => Promise<unknown>
}

function buildMockCtx() {
  const routes: RegisteredRoute[] = []
  const healthChecks: RegisteredHealthCheck[] = []
  return {
    routes,
    healthChecks,
    ctx: {
      pluginId: '_template',
      registerRoute: (route: RegisteredRoute) => { routes.push(route) },
      registerHealthCheck: (def: RegisteredHealthCheck) => {
        healthChecks.push(def)
        return `_template.${def.id}`
      },
      registerNav: () => {},
      registerSlot: () => {},
      registerExecTool: () => {},
      registerSkill: () => {},
      registerWorkflow: () => {},
      registerNodeType: () => '_template.kind',
      registerNotificationChannel: () => '_template.id',
      watchFiles: () => {},
      getSettings: () => ({}),
      updateSettings: () => {},
      activity: { log: () => {}, audit: () => {} },
      search: { index: async () => {}, remove: async () => {}, registerContentType: () => {}, registerFileBackedContentType: () => {} },
      hooks: { register: () => () => {}, has: () => false, invoke: async () => undefined },
      storage: {} as unknown,
      events: {} as unknown,
    } as unknown,
  }
}

describe('_template plugin', () => {
  it('registers a GET / route returning ok=true', async () => {
    const { ctx, routes } = buildMockCtx()
    await plugin.activate(ctx as Parameters<typeof plugin.activate>[0])

    const root = routes.find((r) => r.method === 'GET' && r.path === '/')
    expect(root).toBeDefined()

    const res = await root!.handler(new Request('http://localhost/'))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.plugin).toBe('_template')

    // Clean up the heartbeat timer so the test doesn't leak.
    await plugin.onShutdown?.()
  })

  it('registers a reachability health check', async () => {
    const { ctx, healthChecks } = buildMockCtx()
    await plugin.activate(ctx as Parameters<typeof plugin.activate>[0])

    const check = healthChecks.find((c) => c.id === 'reachability')
    expect(check).toBeDefined()

    const result = await check!.run() as Array<{ status: string }>
    expect(result[0].status).toBe('ok')

    await plugin.onShutdown?.()
  })
})
