import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecToolDefinition, HealthCheckRegistrationInput, PluginContext, PluginToolContext } from '@makinbakin/sdk/types'
import plugin from '../index'

test('plugin activation registers protected tools and honest health without starting a service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-plugin-'))
  const tools: ExecToolDefinition[] = []
  const checks: HealthCheckRegistrationInput[] = []
  const context = {
    storage: { localRoot: root }, getSettings: () => ({ enabledAgents: [{ id: 'patch' }] }),
    hooks: { register: () => () => {}, invoke: async () => undefined },
    tasks: { get: async () => undefined }, log: { error: () => {} },
    registerExecTool: (tool: ExecToolDefinition) => { tools.push(tool) },
    registerHealthCheck: (check: HealthCheckRegistrationInput) => { checks.push(check); return check.id },
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
    expect(await response.json()).toEqual({ sessions: [], serviceReady: false })
    await plugin.beforeUninstall?.()
  } finally { await plugin.onShutdown?.(); rmSync(root, { recursive: true, force: true }) }
})
