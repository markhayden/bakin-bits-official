import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecToolDefinition, HealthCheckRegistrationInput, HealthRepairActionDefinition, PluginContext, PluginToolContext } from '@makinbakin/sdk/types'
import plugin from '../index'

test('plugin activation registers protected tools and honest health without starting a service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-plugin-'))
  const tools: ExecToolDefinition[] = []
  const checks: HealthCheckRegistrationInput[] = []
  const repairs: HealthRepairActionDefinition[] = []
  const context = {
    storage: { localRoot: root }, getSettings: () => ({ enabledAgents: ['patch'] }),
    hooks: { register: () => () => {}, invoke: async () => undefined },
    tasks: { get: async () => undefined }, log: { error: () => {} },
    registerExecTool: (tool: ExecToolDefinition) => { tools.push(tool) },
    registerHealthRepairAction: (action: HealthRepairActionDefinition) => { repairs.push(action); return action.id },
    registerHealthCheck: (check: HealthCheckRegistrationInput) => {
      // Health requires every declared repair action to be registered first.
      expect(repairs.map((action) => action.id)).toContain('setup-service')
      checks.push(check); return check.id
    },
  } as unknown as PluginContext
  try {
    await plugin.activate(context)
    expect(tools).toHaveLength(1)
    expect(tools[0].requiresVerifiedAgent).toBe(true)
    expect((await tools[0].handler({ operation: 'list', input: {} }, 'patch')).ok).toBe(false)
    const verified = { invocation: { agentId: 'patch' } } as PluginToolContext
    expect(await tools[0].handler({ operation: 'list', input: { agentId: 'chef' } }, 'chef', verified)).toEqual({ ok: true, sessions: [] })
    const health = await checks[0].run()
    expect(health.outcome).toBe('observed')
    if (health.outcome === 'observed') expect(health.observations[0].status).toBe('warning')
    const route = plugin.routes!.find((entry) => entry.path === '/sessions' && entry.method === 'GET')!
    const response = await route.handler(new Request('http://localhost/sessions', { headers: { 'x-bakin-terminal-client': 'isolated-browser-client' } }), context as unknown as Parameters<typeof route.handler>[1], {} as never)
    expect(await response.json()).toEqual({ sessions: [], serviceReady: false, serviceUpdateRequired: false })
    // The service-update incident is repaired by the drained setup action.
    expect(checks[0].incidents).toContainEqual({ id: 'service-update', subjectKind: 'plugin', resolution: { type: 'repair', actionId: 'setup-service' }, required: 'never' })
    const [setup] = repairs
    expect(setup).toMatchObject({ id: 'setup-service', mutation: 'restart', effects: { deletesUserContent: false, spendsMoney: false, widensAuthorization: false } })
    // No installed service, nothing to update: the plan is empty.
    expect(await setup!.plan({ type: 'all', reportId: 'r' } as never)).toEqual([])
    await plugin.beforeUninstall?.()
  } finally { await plugin.onShutdown?.(); rmSync(root, { recursive: true, force: true }) }
})
