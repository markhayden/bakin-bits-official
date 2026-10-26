import { mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { definePlugin, defineRoute, defineSocketRoute } from '@makinbakin/sdk'
import type { PluginContext, PluginToolContext, HealthObservationInput } from '@makinbakin/sdk/types'
import { z } from 'zod'
import { Store } from './lib/store'
import { TerminalService } from './lib/service'
import { TmuxProcesses } from './lib/processes'
import { Sessions } from './lib/sessions'
import { TerminalError, terminalSettings, type Principal } from './lib/contracts'
import { agentCommand, command, creatingScreen, failure, human } from './lib/http'
import { sessionOptions } from './lib/session-options'
import { TerminalViewer } from './lib/socket'
import { attachBody, confirmBody, createAndLaunch, launch, newBody, operator, resolveRef, sessionTable } from './lib/cli'

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
  id: 'terminal', name: 'Terminal', version: '0.4.0-dev.4',
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
      const list = sessions().list(principal).map((session) => ({ ...session, nativeClients: sessions().nativeClients(session.id).length }))
      return Response.json({ sessions: list, serviceReady, serviceUpdateRequired: await service?.updateRequired() })
    }),
    route('/sessions', 'POST', 'Create a terminal session', async (request) => {
      const principal = human(request)
      const body = await request.json() as Record<string, unknown>
      return Response.json(await sessions().create(body, principal, creatingScreen(body.size)))
    }),
    route('/session', 'POST', 'Operate a terminal session', async (request) => {
      const principal = human(request)
      const body = await request.json() as { id?: unknown; operation?: unknown }
      if (body.operation === 'default-size') {
        // "Use this size as the default for new sessions": the operator's current grid.
        const session = sessions().get(z.string().min(1).parse(body.id), principal)
        context!.updateSettings({ defaultCols: session.cols, defaultRows: session.rows })
        return Response.json({ defaultSize: { cols: session.cols, rows: session.rows } })
      }
      return Response.json(await command(sessions(), body, principal))
    }),
    // bakin terminal new | attach | ls: continue a session in a terminal app (lib/cli.ts).
    route('/cli/new', 'POST', 'Create a session and attach this terminal to it', async (request) => {
      const principal = operator(request)
      return Response.json(await createAndLaunch(sessions(), newBody.parse(await request.json()), principal))
    }),
    route('/cli/attach', 'POST', 'Attach this terminal to a session', async (request) => {
      const principal = operator(request)
      const { params } = attachBody.parse(await request.json())
      return Response.json(await launch(sessions(), resolveRef(sessions().list(principal), params.ref).id, principal))
    }),
    route('/cli/confirm', 'POST', 'Admit the launched terminal app', async (request) => {
      operator(request)
      const { token, pid } = confirmBody.parse(await request.json())
      await sessions().confirmAttach(token, pid)
      return Response.json({ admitted: true })
    }),
    route('/cli/ls', 'GET', 'List sessions for the terminal', async (request) => {
      const principal = operator(request)
      if (await service?.ready()) await sessions().refreshStates()
      return Response.json(sessionTable(sessions().list(principal), (id) => sessions().nativeClients(id)))
    }),
    route('/service', 'POST', 'Set up the persistent terminal service', async (request) => { human(request); await sessions().setupService(() => service!.install()); return Response.json({ ready: true }) }),
  ],
  socketRoutes: [
    defineSocketRoute({
      path: '/socket',
      summary: 'Live terminal output and input for one viewer',
      admit: (request) => {
        const id = new URL(request.url).searchParams.get('id') ?? ''
        if (!manager?.store.sessions().some((session) => session.id === id)) return Response.json({ error: 'Session not found' }, { status: 404 })
      },
      open: (socket, request) => { new TerminalViewer(sessions(), socket, new URL(request.url).searchParams.get('id')!) },
    }),
  ],
  settingsSchema: { fields: [
    { key: 'enabledAgents', label: 'Enable terminal access', description: 'Enabled agents can open and operate terminal sessions. A session is a real shell running as your user, so an enabled agent can read any file you can — including stored API keys and credentials. Enable only agents you trust with full access to this machine.', type: 'agent-toggles', default: ['main'] },
    { key: 'defaultCols', label: 'Default columns for new sessions', description: 'Sessions an agent starts (or that no screen sized yet) use this grid. Session actions › Use this size as the default sets both from a session you are viewing.', type: 'number', default: 200 },
    { key: 'defaultRows', label: 'Default rows for new sessions', type: 'number', default: 60 },
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
      settings: () => terminalSettings(ctx.getSettings<Record<string, unknown>>()),
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
    // Three outcomes (Bakin self-healing PR 1): every family is declared up front and every
    // instance names its subject — the Terminal page is the operator's control for all three.
    const TERMINAL_SUBJECT = { kind: 'plugin', id: 'terminal', label: 'Terminal' } as const
    // A service update restarts the private tmux server; setup itself refuses
    // while any session is live, so applying it never ends running work.
    ctx.registerHealthRepairAction({
      id: 'setup-service',
      name: 'Apply the Terminal service update',
      effects: { deletesUserContent: false, spendsMoney: false, widensAuthorization: false },
      mutation: 'restart',
      operationPlan: () => ({ stages: [{ id: 'setup', kind: 'committing', label: 'Restart the Terminal service with the update' }], pointOfNoReturn: 'setup' }),
      async plan() {
        if (!await service?.updateRequired()) return []
        return [{
          id: 'setup', actionId: 'setup-service', title: 'Apply the Terminal service update',
          reason: 'The running Terminal service is not the one this plugin version sets up.',
          incidentIds: [], observationIds: [], preconditions: [],
          changes: [{ kind: 'service', target: 'terminal', action: 'update', description: 'Restart the private tmux server with the managed binary and the generated configuration' }],
        }]
      },
      async apply(items, op) {
        const item = items[0]
        if (!item) return []
        op.stage('setup')
        try {
          await sessions().setupService(() => service!.install())
          return [{ itemId: item.id, actionId: item.actionId, status: 'applied', message: 'The Terminal service runs the current configuration.', affectedCheckIds: ['terminal.service'], changes: item.changes }]
        } catch (error) {
          return [{ itemId: item.id, actionId: item.actionId, status: 'failed', message: error instanceof Error ? error.message : String(error), affectedCheckIds: ['terminal.service'], changes: [] }]
        }
      },
    })
    ctx.registerHealthCheck({
      id: 'service', name: 'Terminal service and retention',
      description: 'Checks persistent terminal availability and retained work needing review.',
      group: { key: 'terminal', label: 'Terminal' },
      incidents: [
        { id: 'service', subjectKind: 'plugin', resolution: { type: 'human', needs: 'decision' }, required: 'never' },
        { id: 'service-update', subjectKind: 'plugin', resolution: { type: 'repair', actionId: 'setup-service' }, required: 'never' },
        { id: 'maintenance', subjectKind: 'plugin', resolution: { type: 'human', needs: 'decision' }, required: 'never' },
        { id: 'retention', subjectKind: 'plugin', resolution: { type: 'human', needs: 'decision' }, required: 'never' },
      ],
      run: async () => {
        const ready = await service?.ready()
        const updateRequired = Boolean(ready && await service?.updateRequired())
        const retained = sessions().list({ kind: 'human', id: 'health' }).filter((session) => session.cleanupReason)
        const observations: HealthObservationInput[] = []
        for (const [key, summary, problem] of [
          ['service', 'Persistent terminal service unavailable', !ready],
          ['maintenance', 'Terminal maintenance failed', maintenanceFailed],
          ['retention', `${retained.length} terminal worktrees need review`, retained.length > 0],
        ] as const) {
          if (problem) observations.push({ key, status: 'warning', summary, incident: {
            key, declarationId: key, subject: TERMINAL_SUBJECT, title: summary,
            impact: key === 'retention' ? 'Unfinished work is retained and may block new worktrees.' : 'Terminal operations or cleanup may be unavailable.',
            class: key === 'retention' ? 'cleanup_backlog' : 'service_failure', disposition: 'watch',
            resolution: { key: 'review', type: 'human', needs: 'decision', label: 'Open Terminal', href: '/terminal' },
          } })
        }
        if (updateRequired) observations.push({ key: 'service-update', status: 'warning', summary: 'Terminal service update available', incident: {
          key: 'service-update', declarationId: 'service-update', subject: TERMINAL_SUBJECT, title: 'Terminal service update available',
          impact: 'Terminal runs an older service setup; native attach and the current terminal configuration need the update. It applies once no session is live.',
          class: 'service_failure', disposition: 'watch',
          resolution: { key: 'apply', type: 'repair', actionId: 'setup-service', label: 'Apply update' },
        } })
        return { outcome: 'observed', observations: observations.length ? [observations[0]!, ...observations.slice(1)] : [{ key: 'service', status: 'healthy', summary: 'Terminal service and retention are healthy.' }] }
      },
    })
    ctx.hooks.register('tasks.statusChanged', async (raw) => {
      const event = raw as { to?: string }
      if (event.to === 'done') await manager?.sweep()
    })
    ctx.registerExecTool({
      name: 'bakin_exec_terminal_session',
      description: [
        'Operate a real terminal session assigned to you. Every response returns the session with its current `generation` and `inputSequence` — always read those from the latest response.',
        'Typical flow: `create` a session, then `screen` to read the visible pane, then `write` to type a command (end it with a trailing carriage return "\\r" to run it), then `screen` again to read the result, then `complete` when finished.',
        'Writing requires `generation` (from your last response) and `sequence` = that response\'s `inputSequence` + 1. If a write fails, call `screen` to re-read the current state — never retry with the same or a guessed sequence.',
        'A human can take control at any time; that bumps `generation` and rejects your writes until control returns. Treat a rejected write as "the human is driving", not an error to retry.',
        'The human\'s screen sizes the session and may change it while you work: every `screen` reports `cols`, `rows` and `sizeRevision`; when the revision moves, re-read the screen before acting on its layout.',
      ].join(' '),
      requiresVerifiedAgent: true,
      parameters: {
        operation: z.enum(['list', 'create', 'screen', 'output', 'write', 'interrupt', 'complete', 'terminate'])
          .describe('list: your sessions. create: start one. screen: read the visible pane and its size (start here). output: read raw output after a cursor. write: type input. interrupt: send Ctrl-C. complete: finish an exited session. terminate: stop a running process then finish.'),
        input: z.object({
          id: z.string().optional().describe('Session id. Required for screen, output, write, interrupt, complete, terminate.'),
          title: z.string().optional().describe('create: a short human-readable name for the session.'),
          cwd: z.string().optional().describe('create: absolute working directory.'),
          program: z.enum(['shell', 'claude', 'codex']).optional().describe('create: program to launch (default shell).'),
          checkout: z.enum(['isolated', 'existing']).optional().describe('create: a new isolated git worktree or the existing checkout at cwd (default: isolated for coding programs, existing for a shell).'),
          taskId: z.string().optional().describe('create: link the session to a Bakin task id.'),
          generation: z.number().int().optional().describe('write, interrupt: the `generation` from your latest response for this session.'),
          sequence: z.number().int().optional().describe('write: the latest `inputSequence` + 1. Consumed once — never reuse or guess it.'),
          data: z.string().optional().describe('write: the exact keystrokes to send. End a command with a carriage return "\\r" to run it.'),
          cursor: z.number().int().optional().describe('output: return output produced after this cursor (0 for all retained output).'),
        }).default({}).describe('Operation arguments — each field notes which operations use it.'),
      },
      handler: async (params, _agent, context) => {
        try {
          const principal = agent(context)
          const input = params.input as Record<string, unknown>
          const operation = params.operation as string
          if (operation === 'list') return { ok: true, sessions: sessions().list(principal) }
          if (operation === 'create') return { ok: true, session: await sessions().create(input, principal) }
          const id = z.string().min(1).parse(input.id)
          if (operation === 'screen') return { ok: true, ...await sessions().readScreen(id, principal) }
          if (operation === 'output') return { ok: true, ...sessions().output(id, principal, z.number().int().nonnegative().parse(input.cursor ?? 0)) }
          return { ok: true, session: await agentCommand(sessions(), { ...input, operation }, principal) }
        } catch (error) { return { ok: false, error: error instanceof TerminalError ? error.message : 'Invalid or unavailable terminal operation' } }
      },
    })
  },
  async beforeUninstall() { await sessions().beforeUninstall(() => service!.uninstall()) },
  async onShutdown() { clearInterval(maintenance); await manager?.shutdown(); manager = undefined; service = undefined; context = undefined },
})
