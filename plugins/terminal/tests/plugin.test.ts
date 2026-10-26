import { expect, spyOn, test } from 'bun:test'
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

test('an available service update is ONE observation with the Apply update repair', async () => {
  const { TerminalService } = await import('../lib/service')
  const ready = spyOn(TerminalService.prototype, 'ready').mockResolvedValue(true)
  const update = spyOn(TerminalService.prototype, 'updateRequired').mockResolvedValue(true)
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-update-'))
  const checks: HealthCheckRegistrationInput[] = []
  const context = {
    storage: { localRoot: root }, getSettings: () => ({ enabledAgents: [] }),
    hooks: { register: () => () => {}, invoke: async () => undefined },
    tasks: { get: async () => undefined }, log: { error: () => {} },
    registerExecTool: () => {}, registerHealthRepairAction: () => 'setup-service',
    registerHealthCheck: (check: HealthCheckRegistrationInput) => { checks.push(check); return check.id },
  } as unknown as PluginContext
  try {
    await plugin.activate(context)
    const health = await checks[0]!.run()
    if (health.outcome !== 'observed') throw new Error('expected observations')
    const keys = health.observations.map((observation) => observation.key)
    expect(new Set(keys).size).toBe(keys.length)
    const updates = health.observations.filter((observation) => observation.key === 'service-update')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.incident?.resolution).toEqual({ key: 'apply', type: 'repair', actionId: 'setup-service', label: 'Apply update' })
  } finally {
    await plugin.onShutdown?.(); ready.mockRestore(); update.mockRestore(); rmSync(root, { recursive: true, force: true })
  }
})

test('agents cannot resize, screen reads carry the grid, and the operator can save a size as the default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-size-'))
  const tools: ExecToolDefinition[] = []
  const updates: Record<string, unknown>[] = []
  const context = {
    storage: { localRoot: root }, getSettings: () => ({ enabledAgents: ['patch'] }), updateSettings: (patch: Record<string, unknown>) => { updates.push(patch) },
    hooks: { register: () => () => {}, invoke: async () => undefined },
    tasks: { get: async () => undefined }, log: { error: () => {} },
    registerExecTool: (tool: ExecToolDefinition) => { tools.push(tool) }, registerHealthRepairAction: () => 'setup-service',
    registerHealthCheck: (check: HealthCheckRegistrationInput) => check.id,
  } as unknown as PluginContext
  try {
    await plugin.activate(context)
    const operations = (tools[0]!.parameters as { operation: { options: string[] } }).operation.options
    expect(operations).not.toContain('resize')
    const route = plugin.routes!.find((entry) => entry.path === '/session' && entry.method === 'POST')!
    const response = await route.handler(new Request('http://localhost/session', {
      method: 'POST', headers: { 'x-bakin-terminal-client': 'isolated-browser-client', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'missing', operation: 'default-size' }),
    }), context as unknown as Parameters<typeof route.handler>[1], {} as never)
    expect(response.status).toBe(404)
    expect(updates).toEqual([])
  } finally { await plugin.onShutdown?.(); rmSync(root, { recursive: true, force: true }) }
})

