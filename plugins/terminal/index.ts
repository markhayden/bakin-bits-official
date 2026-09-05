import { mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { definePlugin, defineRoute } from '@makinbakin/sdk'
import type { PluginContext, PluginToolContext, HealthObservationInput } from '@makinbakin/sdk/types'
import { z } from 'zod'
import { Store } from './lib/store'
import { TerminalService } from './lib/service'
import { TmuxProcesses } from './lib/processes'
import { Sessions } from './lib/sessions'
import { TerminalError, terminalSettings, type Principal, type TerminalSettings } from './lib/contracts'
import { command, failure, human, stream } from './lib/http'
import { sessionOptions } from './lib/session-options'

let manager: Sessions | undefined
let service: TerminalService | undefined
let maintenance: ReturnType<typeof setInterval> | undefined
let maintenanceFailed = false
let context: PluginContext | undefined
function sessions(): Sessions {
  if (!manager) throw new TerminalError('Terminal is unavailable', 503)
  return manager
}
function agent(context?: PluginToolContext): Principal {
  if (!context?.invocation?.agentId) throw new TerminalError('Verified agent identity required', 403)
  return { kind: 'agent', id: context.invocation.agentId }
}
const route = (path: string, method: 'GET' | 'POST', summary: string, handler: (request: Request) => Promise<Response>) => defineRoute({
  path, method, summary,
  handler: async (request) => { try { return await handler(request) } catch (error) { return failure(error) } },
})

export default definePlugin({
  id: 'terminal', name: 'Terminal', version: '0.1.0',
  routes: [
    route('/options', 'GET', 'Get terminal form defaults and available agents and tasks', async (request) => {
      const principal = human(request)
      if (!context) throw new TerminalError('Terminal is unavailable', 503)
      return Response.json(await sessionOptions(context, sessions().list(principal)))
    }),
    route('/sessions', 'GET', 'List terminal sessions', async (request) => {
      const principal = human(request)
      const serviceReady = await service?.ready()
      if (serviceReady) await sessions().refreshStates()
      return Response.json({ sessions: sessions().list(principal), serviceReady })
    }),
    route('/sessions', 'POST', 'Create a terminal session', async (request) => { const principal = human(request); return Response.json(await sessions().create(await request.json(), principal)) }),
    route('/session', 'POST', 'Operate a terminal session', async (request) => { const principal = human(request); return Response.json(await command(sessions(), await request.json(), principal)) }),
    route('/stream', 'GET', 'Stream private terminal output', async (request) => stream(sessions(), request)),
    route('/history', 'GET', 'Read bounded terminal history', async (request) => {
      const principal = human(request)
      const url = new URL(request.url)
      const cursor = z.coerce.number().int().nonnegative().parse(url.searchParams.get('cursor') ?? 0)
      return Response.json(sessions().output(url.searchParams.get('id') ?? '', principal, cursor))
    }),
    route('/service', 'POST', 'Set up the persistent terminal service', async (request) => { human(request); await service?.install(); await sessions().start(); return Response.json({ ready: true }) }),
  ],
  settingsSchema: { fields: [
    { key: 'enabledAgents', label: 'Terminal-enabled agents', type: 'list', default: [], addLabel: 'Add agent', uniqueField: 'id', itemShape: { id: { key: 'id', label: 'Agent ID', type: 'string', required: true } } },
    { key: 'maxSessions', label: 'Maximum live sessions', type: 'number', default: 10 },
    { key: 'maxWorktrees', label: 'Maximum retained worktrees', type: 'number', default: 10 },
    { key: 'idleDays', label: 'Idle worktree review age (days)', type: 'number', default: 30 },
  ] },
  async activate(ctx: PluginContext) {
    context = ctx
    const root = ctx.storage.localRoot
    if (!root) throw new Error('Terminal requires Bakin with local plugin storage and verified invocation support')
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
    service = new TerminalService(root)
    manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), {
      settings: () => terminalSettings(ctx.getSettings<TerminalSettings>()),
      prepare: (input) => ctx.hooks.invoke('git.prepareSessionWorktree', input),
      release: (input) => ctx.hooks.invoke('git.releaseSessionWorktree', input),
      validateLinks: async (input) => {
        if (input.taskId && !await ctx.tasks.get(input.taskId)) throw new TerminalError('Linked task was not found', 400)
      },
    })
    if (await service.ready()) await manager.start()
    const maintain = async () => {
      if (await service?.ready()) await manager?.refreshStates()
      await manager?.sweep()
    }
    const maintenancePass = async () => {
      try { await maintain(); maintenanceFailed = false }
      catch (error) { maintenanceFailed = true; ctx.log?.error('Terminal maintenance failed; retained work was not removed', error instanceof Error ? error : new Error(String(error))) }
    }
    await maintenancePass()
    maintenance = setInterval(() => { void maintenancePass() }, 60 * 60 * 1000)
    ctx.registerHealthCheck({
      id: 'service', name: 'Terminal service and retention',
      description: 'Checks persistent terminal availability and retained work needing review.',
      group: { key: 'terminal', label: 'Terminal' },
      run: async () => {
        const ready = await service?.ready()
        const retained = sessions().list({ kind: 'human', id: 'health' }).filter((session) => session.cleanupReason)
        const observations: HealthObservationInput[] = []
        for (const [key, summary, problem] of [
          ['service', 'Persistent terminal service unavailable', !ready],
          ['maintenance', 'Terminal maintenance failed', maintenanceFailed],
          ['retention', `${retained.length} terminal worktrees need review`, retained.length > 0],
        ] as const) {
          if (problem) observations.push({ key, status: 'warning', summary, incident: {
            key, title: summary, impact: key === 'retention' ? 'Unfinished work is retained and may block new worktrees.' : 'Terminal operations or cleanup may be unavailable.',
            class: key === 'retention' ? 'cleanup_backlog' : 'service_failure', disposition: 'watch',
            resolution: { key: 'review', type: 'navigate', label: 'Open Terminal', href: '/terminal' },
          } })
        }
        return { outcome: 'observed', observations: observations.length ? [observations[0]!, ...observations.slice(1)] : [{ key: 'service', status: 'healthy', summary: 'Terminal service and retention checks passed' }] }
      },
    })
    ctx.hooks.register('tasks.statusChanged', async (raw) => {
      const event = raw as { to?: string }
      if (event.to === 'done') await manager?.sweep()
    })
    ctx.registerExecTool({
      name: 'bakin_exec_terminal_session',
      description: 'Use an assigned terminal. List/create/read-screen/read-output/write/interrupt/complete share the human terminal. Writes require the current generation and next inputSequence. Never retry an ambiguous write. Human takeover blocks input until control is returned. Terminal access must be enabled for this agent.',
      requiresVerifiedAgent: true,
      parameters: {
        operation: z.enum(['list', 'create', 'screen', 'output', 'write', 'resize', 'interrupt', 'complete', 'terminate']),
        input: z.record(z.string(), z.unknown()).default({}),
      },
      handler: async (params, _agent, context) => {
        try {
          const principal = agent(context)
          const input = params.input as Record<string, unknown>
          const operation = params.operation as string
          if (operation === 'list') return { ok: true, sessions: sessions().list(principal) }
          if (operation === 'create') return { ok: true, session: await sessions().create(input, principal) }
          const id = z.string().min(1).parse(input.id)
          if (operation === 'screen') return { ok: true, screen: await sessions().readScreen(id, principal) }
          if (operation === 'output') return { ok: true, ...sessions().output(id, principal, z.number().int().nonnegative().parse(input.cursor ?? 0)) }
          return { ok: true, session: await command(sessions(), { ...input, operation }, principal) }
        } catch (error) { return { ok: false, error: error instanceof TerminalError ? error.message : 'Invalid or unavailable terminal operation' } }
      },
    })
  },
  async beforeUninstall() { await sessions().beforeUninstall(() => service!.uninstall()) },
  async onShutdown() { clearInterval(maintenance); await manager?.shutdown(); manager = undefined; service = undefined; context = undefined },
})
