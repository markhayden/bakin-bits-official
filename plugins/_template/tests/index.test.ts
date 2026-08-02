/**
 * Smoke test for the _template plugin.
 *
 * Exercises declarative routes directly, then activates the plugin against a
 * hand-rolled minimal PluginContext to verify its lifecycle-owned health check.
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

interface RegisteredHealthCheck {
  id: string
  run: () => Promise<unknown>
}

function buildMockCtx() {
  const healthChecks: RegisteredHealthCheck[] = []
  return {
    healthChecks,
    ctx: {
      pluginId: '_template',
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
  it('declares GET / and POST /greet routes', async () => {
    const routes = plugin.routes ?? []
    const root = routes.find((route) => route.method === 'GET' && route.path === '/')
    const greet = routes.find((route) => route.method === 'POST' && route.path === '/greet')
    expect(root).toBeDefined()
    expect(greet).toBeDefined()

    const res = await root!.handler(new Request('http://localhost/'), {} as never, {} as never)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.plugin).toBe('_template')

    const greeting = await greet!.handler(
      new Request('http://localhost/greet', { method: 'POST' }),
      {} as never,
      { body: { name: 'Builder' } } as never,
    )
    expect(await greeting.json()).toEqual({
      message: 'Hello, Builder. Your plugin route is working.',
    })
  })

  it('registers a reachability health check', async () => {
    const { ctx, healthChecks } = buildMockCtx()
    await plugin.activate(ctx as Parameters<typeof plugin.activate>[0])

    const check = healthChecks.find((c) => c.id === 'reachability')
    expect(check).toBeDefined()

    const result = await check!.run() as {
      outcome: string
      observations: Array<{ status: string }>
    }
    expect(result.outcome).toBe('observed')
    expect(result.observations[0].status).toBe('healthy')

    await plugin.onShutdown?.()
  })
})
