/**
 * Projects plugin — server entry point.
 * Registers API routes, exec tools, and the task-link index.
 */
import { z } from 'zod'
import { defineRoute } from '@makinbakin/sdk'
import type { BakinPlugin, PluginContext, RuntimeAgent } from '@makinbakin/sdk/types'
import { conversationThreadId } from '@makinbakin/sdk/utils'
import { createProjectRepository, PlanHistoryUnavailableError, projectToSummary } from './lib/parser'
import { createProjectService, deriveChecklist } from './lib/project-service'
import { ProjectMutationError } from './lib/project-mutations'
import { buildProjectBrainstormContext } from './lib/brainstorm-prompt'
import type { MutationCaller, Project, ProjectBrainstormMessage, ProjectStatus, ProjectPatch, ChecklistPatch, ProducedFile } from './types'

const log = {
  info: (...args: unknown[]) => console.info('[projects]', ...args),
  warn: (...args: unknown[]) => console.warn('[projects]', ...args),
  error: (...args: unknown[]) => console.error('[projects]', ...args),
}

let activeProjectRepository: ReturnType<typeof createProjectRepository> | null = null
/** Bound in activate(); onReady resumes kickoffs a crash left pending (D8). */
let resumePendingKickoffs: (() => Promise<void>) | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mutationFailure(error: unknown): Response {
  if (error instanceof SyntaxError) return json({ error: 'Invalid JSON request.', code: 'invalid_request' }, 400)
  if (error instanceof ProjectMutationError) return json({ error: error.message, code: error.code, conflicts: error.conflicts }, error.status)
  log.error('Project mutation failed', error)
  return json({ error: error instanceof PlanHistoryUnavailableError ? error.message : 'Project could not be saved. Try again.', code: 'storage_error' }, 500)
}

/**
 * Who is calling a REST mutation (D9a): the Projects UI declares the
 * operator (`OPERATOR_DECLARATION_HEADERS`); a request from an agent context
 * (`X-Bakin-Agent-Context`) or with no declaration is held to the agent
 * rules. Declared, not verified — the HTTP API has no authentication, the
 * same documented limit as approvals.
 */
function callerFromRequest(req: Request): MutationCaller {
  const agent = req.headers.get('x-bakin-agent-context')
  if (agent !== null) return { kind: 'agent', agentId: agent.trim() || 'unknown' }
  return req.headers.get('x-bakin-operator') === 'declared' ? { kind: 'user' } : { kind: 'agent', agentId: 'unknown' }
}

async function readBody<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>
}

/** Run `work` over `items` with at most `limit` in flight. */
async function forEachLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) await work(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

async function getRuntimeMainAgentId(ctx: PluginContext): Promise<string> {
  const agents = await ctx.runtime.agents.list()
  const main = agents.find((agent: RuntimeAgent) => agent.metadata?.main === true)
    ?? agents.find((agent: RuntimeAgent) => agent.id === 'main')
    ?? agents[0]
  return main?.id ?? 'main'
}

// ---------------------------------------------------------------------------
// Declarative routes (late-binding)
//
// Routes are static on the plugin object, but every handler closes over
// activate()-created services (repo, project service, index helpers). The
// bridge: activate() fills `routeHandlers`, and each declarative entry
// trampolines into it. Path params are merged into the request's
// searchParams — the contract the legacy handlers already read — so the
// handler bodies are unchanged from the ctx.registerRoute era.
// ---------------------------------------------------------------------------

type LegacyHandler = (req: Request) => Promise<Response> | Response
const routeHandlers = new Map<string, LegacyHandler>()

function paramsSchemaFor(path: string): { params?: z.ZodObject<Record<string, z.ZodString>> } {
  const keys = [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1])
  if (keys.length === 0) return {}
  return { params: z.object(Object.fromEntries(keys.map((k) => [k, z.string()]))) }
}

function legacyRoute(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, summary: string) {
  return defineRoute({
    method,
    path,
    summary,
    description: summary,
    ...paramsSchemaFor(path),
    handler: async (req: Request, _ctx: unknown, parsed: { params?: Record<string, string> }) => {
      const handler = routeHandlers.get(`${method} ${path}`)
      if (!handler) return json({ error: 'projects plugin not ready' }, 503)
      const url = new URL(req.url)
      for (const [key, value] of Object.entries(parsed?.params ?? {})) {
        url.searchParams.set(key, String(value))
      }
      return handler(new Request(url, req))
    },
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const projectsPlugin: BakinPlugin = {
  id: 'projects',
  name: 'Projects',
  version: '2.0.0',

  navItems: [
    { id: 'projects', label: 'Projects', icon: 'FolderKanban', href: '/projects', order: 30 },
  ],

  routes: [
    legacyRoute('GET', '/', 'List projects'),
    legacyRoute('GET', '/:projectId', 'Get project by ID'),
    legacyRoute('POST', '/', 'Create project'),
    legacyRoute('PUT', '/:projectId', 'Update project; optional expected values protect edited fields (409 on overlap)'),
    legacyRoute('DELETE', '/:projectId', 'Delete project'),
    legacyRoute('POST', '/:projectId/checklist', 'Add checklist item'),
    legacyRoute('PUT', '/:projectId/checklist/:itemId/toggle', 'Toggle checklist item'),
    legacyRoute('PUT', '/:projectId/checklist/:itemId', 'Update checklist item'),
    legacyRoute('DELETE', '/:projectId/checklist/:itemId', 'Remove checklist item'),
    legacyRoute('POST', '/:projectId/checklist/:itemId/link', 'Link checklist item to task'),
    legacyRoute('POST', '/:projectId/checklist/:itemId/promote', 'Promote item to task'),
    legacyRoute('GET', '/:projectId/files', 'Files produced by the project\'s board tasks (derived)'),
    legacyRoute('POST', '/:projectId/assets', 'Attach asset'),
    legacyRoute('PATCH', '/:projectId/assets/:assetId', 'Relink asset reference'),
    legacyRoute('DELETE', '/:projectId/assets/:assetId', 'Detach asset'),
    legacyRoute('POST', '/:projectId/ask', 'Ask agent about project (202; streams over the plugin-event bus)'),
    legacyRoute('POST', '/:projectId/ask/abort', 'Abort the in-flight brainstorm turn'),
    legacyRoute('GET', '/brainstorm/attention', 'Brainstorm attention totals (unread + in-flight)'),
    legacyRoute('POST', '/:projectId/brainstorm/seen', 'Mark a project brainstorm as seen'),
    legacyRoute('POST', '/:projectId/plan/seen', 'Mark a plan revision as seen (the "Plan updated" baseline)'),
    legacyRoute('GET', '/:projectId/history', 'Plan body snapshot history (oldest first)'),
    legacyRoute('POST', '/:projectId/history/:index/restore', 'Restore a plan snapshot (snapshots current first)'),
  ],

  async activate(ctx: PluginContext) {
    routeHandlers.clear()
    const repo = createProjectRepository(ctx.storage)
    activeProjectRepository = repo
    const projectService = createProjectService(ctx, repo)
    const {
      createProject,
      updateProject,
      applyProjectPlan,
      deleteProject,
      addChecklistItem,
      markChecklistItem,
      updateChecklistItem,
      removeChecklistItem,
      linkChecklistItem,
      promoteItemToTask,
      attachAsset,
      relinkAsset,
      detachAsset,
      rebuildIndex,
      resolveLinkedTaskStatuses,
      boardIndex,
      derive,
    } = projectService
    const readProject = repo.readProject
    const readAllProjects = repo.readAllProjects
    const readBrainstormMessages = repo.readBrainstormMessages
    const writeBrainstormMessages = repo.writeBrainstormMessages

    // Brainstorm turns run on the shared conversation turn engine
    // (bakin#703): server-owned background turns, streamed as
    // projects.brainstorm.* plugin-events, persisted incrementally into the
    // per-project transcript — navigating away never kills a turn. The
    // runtime thread stays the durable per-(project, agent) session.
    const brainstormTurns = ctx.conversations.createTurnService({
      name: 'projects.brainstorm',
      events: {
        chunk: 'projects.brainstorm.chunk',
        done: 'projects.brainstorm.done',
        error: 'projects.brainstorm.error',
        // Fires at 202-accept — the nav working dot must not wait out model
        // latency for the first chunk (bakin#707).
        started: 'projects.brainstorm.started',
      },
      payload: (key) => ({ projectId: key }),
      resolveThread: async (key) =>
        readProject(key) ? { agentId: await getRuntimeMainAgentId(ctx) } : null,
      appendRow: (key, row) => {
        // A turn racing a delete must not resurrect the sidecar as a
        // permanent orphan — the throw surfaces as the engine's logged
        // append failure.
        if (!readProject(key)) throw new Error(`project ${key} is gone — dropping brainstorm row`)
        writeBrainstormMessages(key, [
          ...readBrainstormMessages(key),
          row as unknown as ProjectBrainstormMessage,
        ])
      },
      threadId: (key, agentId) => conversationThreadId('projects', key, agentId),
      metering: {
        workClass: 'chat',
        runId: (key, turnId) => `brainstorm:projects:${key}:turn:${turnId}`,
      },
      hooks: {
        // The kickoff receipt rides until its first turn settles (D8).
        onSettled: async ({ key }) => {
          const kickoff = readProject(key)?.kickoff
          if (kickoff?.state === 'started') await projectService.advanceKickoff(key, kickoff.requestId, 'started', 'settled')
        },
      },
    })

    /**
     * Start a pending kickoff's first brainstorm turn — the SAME path as
     * /ask. `started` is written only after the engine accepts, so a retry
     * or the boot sweep can never start it twice; a busy engine leaves it
     * pending for the next attempt.
     */
    // In-process admission: one start attempt per project at a time. The
    // receipt is re-read after the awaits, so a retry that lost the race to
    // a completed start never starts the turn again.
    const startingKickoffs = new Set<string>()
    /** `pending` = the engine did not admit the turn; the receipt stays for a retry. */
    async function startKickoff(projectId: string): Promise<'started' | 'in-flight' | 'pending'> {
      if (startingKickoffs.has(projectId)) return 'in-flight'
      startingKickoffs.add(projectId)
      try {
        const project = readProject(projectId)
        const kickoff = project?.kickoff
        if (!project || kickoff?.state !== 'pending' || !kickoff.message) return 'started'
        // The engine persists the user row BEFORE accepting: a transcript is
        // proof the turn was already accepted (e.g. the `started` write failed).
        if (readBrainstormMessages(projectId).length > 0) {
          await projectService.advanceKickoff(projectId, kickoff.requestId, 'pending', 'started')
          return 'started'
        }
        const runtimeContent = buildProjectBrainstormContext(await derive(project), kickoff.message, { live: true })
        if (readProject(projectId)?.kickoff?.state !== 'pending') return 'started'
        const result = await brainstormTurns.start(ctx, projectId, kickoff.message, {
          agentId: kickoff.agentId ?? project.owner,
          runtimeContent,
        })
        if (result !== 'accepted') return 'pending'
        await projectService.advanceKickoff(projectId, kickoff.requestId, 'pending', 'started')
        return 'started'
      } finally {
        startingKickoffs.delete(projectId)
      }
    }

    resumePendingKickoffs = async () => {
      for (const project of readAllProjects()) {
        const kickoff = project.kickoff
        if (!kickoff || kickoff.state === 'settled') continue
        try {
          // A turn alive at boot died with the process (the interrupted-turn
          // sweep already stamped its transcript). The engine persists the
          // user row BEFORE accepting, so a pending receipt with a transcript
          // was accepted too — settle both; only a truly unstarted kickoff runs.
          if (kickoff.state === 'started' || readBrainstormMessages(project.id).length > 0) {
            await projectService.advanceKickoff(project.id, kickoff.requestId, kickoff.state, 'settled')
          } else {
            await startKickoff(project.id)
          }
        } catch (err) {
          log.error('kickoff resume failed', err, { projectId: project.id })
        }
      }
    }

    // ─── Search Content Type Registration ─────────────────────────────

    /** Convert a project to a search document (progress derived from the board). */
    async function projectToSearchDoc(raw: Project): Promise<Record<string, unknown>> {
      const project = await derive(raw)
      return {
        title: project.title,
        body: project.body,
        status: project.status,
        progress: project.progress,
        updated_at: project.updated || new Date().toISOString(),
      }
    }

    ctx.search.registerFileBackedContentType({
      table: 'projects',
      schema: {
        title: { type: 'text' },
        body: { type: 'text' },
        status: { type: 'keyword' },
        progress: { type: 'number' },
        updated_at: { type: 'datetime' },
      },
      searchableFields: ['title', 'body'],
      rerankField: 'body',
      embeddingTemplate: '{{title}} {{body}}',
      facets: ['status'],
      chunker: { enabled: true, targetTokens: 200, overlapTokens: 25 },
      filePatterns: [
        {
          pattern: repo.projectsGlob(),
          fileToId: (rel) => rel.replace(/^projects\//, '').replace(/\.md$/, ''),
          fileToDoc: async (rel) => {
            const id = rel.split('/').pop()?.replace(/\.md$/, '') ?? ''
            const project = readProject(id)
            return project ? projectToSearchDoc(project) : null
          },
        },
      ],
      reindex: async function* () {
        const projects = readAllProjects()
        for (const project of projects) {
          yield { key: project.id, doc: await projectToSearchDoc(project) }
        }
      },
      verifyExists: async (key: string) => {
        return ctx.storage.exists(repo.projectStoragePath(key))
      },
    })

    /** Index a project by looking it up and indexing its current state */
    async function indexProject(projectId: string): Promise<void> {
      try {
        const project = readProject(projectId)
        if (project) {
          await ctx.search.index(projectId, await projectToSearchDoc(project))
        }
      } catch (err) {
        log.warn('Failed to index project', { projectId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Register task extension hooks. Core emits task lifecycle events and
    // the tasks plugin asks for generic detail enrichment; projects owns the
    // project-specific behavior behind those extension points.
    // Linked-step completion is DERIVED from the board (D16a) — a column
    // change writes nothing here; it only tells open project pages to refetch.
    ctx.hooks.register('tasks.statusChanged', (d: unknown) => {
      const taskId = (d as Record<string, unknown>).taskId
      const entry = typeof taskId === 'string' ? projectService.getProjectForTask(taskId) : undefined
      if (entry) ctx.events.emit('projects.changed', { projectId: entry.projectId, action: 'task.statusChanged', taskItemId: entry.taskItemId })
    }, {
      label: 'Refresh project task state.',
      summary: 'Tells open project pages to refetch when a linked task changes column; linked step completion is derived from the board at read time.',
      hookKind: 'event',
    })
    ctx.hooks.register('tasks.enrichDetails', async (d: unknown) => {
      const data = d as Record<string, unknown>
      const task = data.task as Record<string, unknown> | undefined
      const projectId = task?.projectId as string | undefined
      if (!projectId) return data

      const stored = readProject(projectId)
      if (!stored) return data
      const project = await derive(stored)

      return {
        ...data,
        projectTitle: project.title,
        projectStatus: project.status,
        projectProgress: project.progress,
        projectExcerpt: project.body.slice(0, 500),
      }
    }, {
      label: 'Add project task context.',
      summary: 'Adds project title, status, progress, and excerpt data to task detail payloads. Use it when a task surface wants project context without depending on project storage.',
      hookKind: 'waterfall',
    })

    // Build in-memory index on startup
    try {
      rebuildIndex()
    } catch (err) {
      log.error('Failed to build project index', err)
    }

    // Watch project files for index rebuilds
    ctx.watchFiles([repo.projectsGlob()])
    ctx.events.on('file.changed', (_event: string, data: Record<string, unknown>) => {
      const path = data.path as string | undefined
      if (path && path.includes('projects/') && path.endsWith('.md')) {
        rebuildIndex()
        ctx.events.emit('projects.changed', { projectId: path.split('/').at(-1)!.slice(0, -3), action: 'file.changed' })
      }
    })

    // -----------------------------------------------------------------
    // API Routes (RESTful + aliases for old paths)
    // -----------------------------------------------------------------

    // Boot sweep (bakin#706): brainstorms whose transcript ends on a user
    // row lost their turn to a process death — stamp an honest error row.
    try {
      for (const project of readAllProjects()) {
        const rows = readBrainstormMessages(project.id)
        const last = rows[rows.length - 1]
        if (last?.kind !== 'user') continue
        writeBrainstormMessages(project.id, [...rows, {
          kind: 'error',
          ts: new Date().toISOString(),
          message: 'Interrupted by a server restart before the reply finished.',
        } as ProjectBrainstormMessage])
      }
    } catch (err) {
      log.error('interrupted-turn sweep failed', err)
    }

    // GET / — list projects
    const listHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const statusFilter = url.searchParams.get('status') as ProjectStatus | null
      let projects = readAllProjects()
      if (statusFilter) projects = projects.filter(p => p.status === statusFilter)
      const board = await boardIndex()
      projects = projects.map(p => deriveChecklist(p, board))
      // Per-project attention flags so list rows can show WHICH project has
      // an unseen reply / running turn (the nav badge names only the count).
      const inflight = new Set(brainstormTurns.listInFlight().map(t => t.key))
      return json({
        projects: projects.map(p => ({
          ...projectToSummary(p),
          brainstormUnread: hasUnseenBrainstormReply(p.id),
          brainstormStreaming: inflight.has(p.id),
          doneCount: p.tasks.filter(task => task.checked).length,
          waitingForYou: repo.readWaitingForUser(p.id),
          planUpdated: p.planUpdatedBy === 'agent' && p.planRevision > repo.readSeen(p.id).planSeenRevision,
        })),
      })
    }
    routeHandlers.set('GET /', listHandler)

    // GET /:projectId — get single project
    const getHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId') || url.searchParams.get('id')
      if (!id) return json({ error: 'Missing id parameter' }, 400)
      const project = await projectService.reconcileLinks(id)
      if (!project) return json({ error: 'Project not found' }, 404)
      const { operations: _operations, ...resolvedProject } = await resolveLinkedTaskStatuses(project)
      // Sample the flag before the preview: if the turn settles between the
      // two reads we return streaming:false with no text (honest), never
      // text without the flag.
      const brainstormStreaming = brainstormTurns.isInFlight(id)
      const brainstormPreview = brainstormStreaming ? brainstormTurns.inflightPreview(id) : null
      return json({
        project: {
          ...resolvedProject,
          planSeenRevision: repo.readSeen(id).planSeenRevision,
          brainstormUnread: hasUnseenBrainstormReply(id),
          brainstormMessages: readBrainstormMessages(id),
          // Server-seeded in-flight flag + streamed-so-far text — a remount
          // mid-turn rehydrates the indicator AND the reply's beginning.
          brainstormStreaming,
          ...(brainstormPreview !== null ? { brainstormStreamingText: brainstormPreview } : {}),
        },
      })
    }
    routeHandlers.set('GET /:projectId', getHandler)

    // POST / — create project. With `requestId` + `firstMessage` it is the
    // start screen's idempotent kickoff (D8): a retry returns the same
    // project and never starts a second first turn.
    const createHandler = async (req: Request) => {
      const body = await readBody<{ title: string; body?: string; owner?: string; tasks?: string[]; requestId?: string; firstMessage?: string }>(req)
      if (!body.title) return json({ error: 'Missing title' }, 400)
      if (body.requestId !== undefined || body.firstMessage !== undefined) {
        try {
          const owner = body.owner || await getRuntimeMainAgentId(ctx)
          const result = await projectService.kickoffProject({
            requestId: body.requestId ?? '', title: body.title, owner, message: body.firstMessage ?? '',
          })
          const started = result.kickoff.state === 'pending' ? await startKickoff(result.id) : 'started'
          if (result.created) indexProject(result.id).catch(() => {})
          // The project exists but its first turn did not start: a retryable
          // failure — the client's retry (same requestId) resumes this project.
          if (started === 'pending') {
            return json({ error: 'The project was created but the conversation could not start. Try again.', code: 'kickoff_pending', id: result.id }, 503)
          }
          return json({ ok: true, id: result.id, created: result.created })
        } catch (error) {
          return mutationFailure(error)
        }
      }
      const owner = body.owner ?? await getRuntimeMainAgentId(ctx)
      const result = await createProject({ ...body, owner, titleSource: 'user' })
      ctx.activity.audit('created', owner, { projectId: result.id, title: body.title })
      ctx.activity.log(owner, `Created project "${body.title}"`)
      indexProject(result.id).catch(() => {})
      return json({ ok: true, ...result })
    }
    routeHandlers.set('POST /', createHandler)

    // PUT /:projectId — update project
    const updateHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<ProjectPatch & { id?: string; expected?: ProjectPatch }>(req).catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid project update' }, 400)
      const { id: bodyId, expected, ...patch } = body
      const id = url.searchParams.get('projectId') || bodyId
      if (!id) return json({ error: 'Missing id' }, 400)
      try {
        await updateProject(id, patch, callerFromRequest(req), expected)
        ctx.activity.audit('updated', 'system', { projectId: id })
        ctx.activity.log('system', `Updated project ${id}`)
        indexProject(id).catch(() => {})
        return json({ ok: true })
      } catch (error) {
        return mutationFailure(error)
      }
    }
    routeHandlers.set('PUT /:projectId', updateHandler)

    // DELETE /:projectId — delete project
    const deleteHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ id?: string; deleteLinkedTasks?: boolean }>(req).catch(() => ({} as { id?: string; deleteLinkedTasks?: boolean }))
      const id = url.searchParams.get('projectId') || body.id
      if (!id) return json({ error: 'Missing id' }, 400)
      // Deleting a project deletes its plan and steps: a human decision (D9a).
      if (callerFromRequest(req).kind === 'agent') {
        return json({ error: 'Agents cannot delete projects — that is the user\'s decision.', code: 'agent_project_delete' }, 403)
      }
      // A live brainstorm must die with its project — otherwise it keeps
      // billing and resurrects the transcript sidecar (review I2).
      brainstormTurns.abort(id)
      try {
        if (body.deleteLinkedTasks) {
          const project = readProject(id)
          if (project) {
            for (const item of project.tasks) {
              if (item.taskId) {
                try { await ctx.tasks.remove(item.taskId) } catch { /* task may already be gone */ }
              }
            }
          }
        }
        await deleteProject(id)
        ctx.activity.audit('deleted', 'system', { projectId: id })
        ctx.activity.log('system', `Deleted project ${id}`)
        ctx.search.remove(id).catch(() => {})
        return json({ ok: true })
      } catch (err: unknown) {
        return json({ error: (err as Error).message }, 400)
      }
    }
    routeHandlers.set('DELETE /:projectId', deleteHandler)

    // POST /:projectId/checklist — add checklist item
    const addItemHandler = async (req: Request) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const body = await readBody<{ projectId?: string; title: string; requestId?: string }>(req)
        const projectId = url.searchParams.get('projectId') || body.projectId
        if (!projectId || !body.title) return json({ error: 'Missing projectId or title' }, 400)
        const result = await addChecklistItem(projectId, body.title, body.requestId)
        indexProject(projectId).catch(() => {})
        return json({ ok: true, ...result })
      } catch (err) {
        return mutationFailure(err)
      }
    }
    routeHandlers.set('POST /:projectId/checklist', addItemHandler)

    // PUT /:projectId/checklist/:itemId/toggle — toggle checklist item
    const toggleHandler = async (req: Request) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const body = await readBody<{ projectId?: string; taskItemId?: string; checked: boolean; expectedInstanceId?: string }>(req)
        const projectId = url.searchParams.get('projectId') || body.projectId
        const taskItemId = url.searchParams.get('itemId') || body.taskItemId
        if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
        const result = await markChecklistItem(projectId, taskItemId, body.checked, body.expectedInstanceId)
        ctx.activity.audit('checklist.toggled', 'system', { projectId, checked: body.checked })
        ctx.activity.log('system', 'Toggled checklist item in project', { taskId: projectId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true, ...result })
      } catch (error) { return mutationFailure(error) }
    }
    routeHandlers.set('PUT /:projectId/checklist/:itemId/toggle', toggleHandler)

    // PUT /:projectId/checklist/:itemId — update checklist item
    const updateItemHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<ChecklistPatch & { projectId?: string; taskItemId?: string; expected?: ChecklistPatch; expectedInstanceId?: string }>(req).catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid checklist update' }, 400)
      const { projectId: bodyProjectId, taskItemId: bodyItemId, expected, expectedInstanceId, ...patch } = body
      const projectId = url.searchParams.get('projectId') || bodyProjectId
      const taskItemId = url.searchParams.get('itemId') || bodyItemId
      if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
      try {
        await updateChecklistItem(projectId, taskItemId, patch, expected, expectedInstanceId)
        ctx.activity.audit('checklist.updated', 'system', { projectId })
        ctx.activity.log('system', 'Updated checklist item in project', { taskId: projectId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true })
      } catch (error) {
        return mutationFailure(error)
      }
    }
    routeHandlers.set('PUT /:projectId/checklist/:itemId', updateItemHandler)

    // DELETE /:projectId/checklist/:itemId — remove checklist item
    const removeItemHandler = async (req: Request) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const body = await readBody<{ projectId?: string; taskItemId?: string; expectedInstanceId?: string }>(req).catch(() => ({} as { projectId?: string; taskItemId?: string; expectedInstanceId?: string }))
        const projectId = url.searchParams.get('projectId') || body.projectId
        const taskItemId = url.searchParams.get('itemId') || body.taskItemId
        if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
        await removeChecklistItem(projectId, taskItemId, callerFromRequest(req), body.expectedInstanceId)
        ctx.activity.audit('checklist.removed', 'system', { projectId })
        ctx.activity.log('system', 'Removed checklist item from project', { taskId: projectId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true })
      } catch (error) { return mutationFailure(error) }
    }
    routeHandlers.set('DELETE /:projectId/checklist/:itemId', removeItemHandler)

    // POST /:projectId/checklist/:itemId/link — link to board task
    const linkHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; taskItemId?: string; taskId: string }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      const taskItemId = url.searchParams.get('itemId') || body.taskItemId
      if (!projectId || !taskItemId || !body.taskId) return json({ error: 'Missing required fields' }, 400)
      await linkChecklistItem(projectId, taskItemId, body.taskId)
      ctx.activity.audit('checklist.linked', 'system', { projectId, taskId: body.taskId })
      ctx.activity.log('system', 'Linked checklist item to task', { taskId: projectId })
      indexProject(projectId).catch(() => {})
      return json({ ok: true })
    }
    routeHandlers.set('POST /:projectId/checklist/:itemId/link', linkHandler)

    // POST /:projectId/checklist/:itemId/promote — promote to board task
    const promoteHandler = async (req: Request) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const body = await readBody<{ projectId?: string; taskItemId?: string; assignee?: string; requestId?: string; expectedInstanceId?: string }>(req)
        const projectId = url.searchParams.get('projectId') || body.projectId
        const taskItemId = url.searchParams.get('itemId') || body.taskItemId
        if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
        const result = await promoteItemToTask(projectId, taskItemId, { assignee: body.assignee, requestId: body.requestId, expectedInstanceId: body.expectedInstanceId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true, ...result })
      } catch (err) { return mutationFailure(err) }
    }
    routeHandlers.set('POST /:projectId/checklist/:itemId/promote', promoteHandler)

    // GET /:projectId/files — what the project's board tasks produced (D17):
    // derived live through the assets plugin's task index, one task per
    // call, bounded fan-out, deduped by asset. Nothing is persisted here.
    routeHandlers.set('GET /:projectId/files', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId')
      if (!id) return json({ error: 'Missing projectId' }, 400)
      const project = readProject(id)
      if (!project) return json({ error: 'Project not found' }, 404)
      const taskIds = new Set(project.tasks.map(item => item.taskId).filter((taskId): taskId is string => Boolean(taskId)))
      try {
        for (const task of await ctx.tasks.list({ projectId: id })) taskIds.add(task.id)
      } catch (err) {
        log.warn('Could not list project tasks for files', { projectId: id, err })
      }
      const produced = new Map<string, ProducedFile>()
      await forEachLimit([...taskIds], 8, async (taskId) => {
        let rows: unknown
        try {
          rows = await ctx.hooks.invoke('assets.listByTask', { taskId })
        } catch (err) {
          log.warn('assets.listByTask failed', { projectId: id, taskId, err })
          return
        }
        if (!Array.isArray(rows)) return
        for (const row of rows as Record<string, unknown>[]) {
          if (typeof row?.assetId !== 'string' || produced.has(row.assetId)) continue
          produced.set(row.assetId, {
            assetId: row.assetId,
            type: typeof row.type === 'string' ? row.type : 'other',
            description: typeof row.description === 'string' ? row.description : '',
            taskId,
          })
        }
      })
      return json({ produced: [...produced.values()] })
    })

    // POST /:projectId/assets — attach asset
    const attachHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; assetId?: string; label?: string }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      if (!projectId || !body.assetId) return json({ error: 'Missing projectId or assetId' }, 400)
      try {
        await attachAsset(projectId, body.assetId, body.label)
        ctx.activity.audit('asset.attached', 'system', { projectId, assetId: body.assetId })
        ctx.activity.log('system', 'Attached asset to project', { taskId: projectId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = message.startsWith('Project not found') || message.startsWith('Asset not found') ? 404 : 400
        return json({ error: message }, status)
      }
    }
    routeHandlers.set('POST /:projectId/assets', attachHandler)

    // PATCH /:projectId/assets/:assetId — relink asset reference
    const relinkHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; assetId?: string; newAssetId?: string; label?: string }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      const assetId = url.searchParams.get('assetId') || body.assetId
      if (!projectId || !assetId || !body.newAssetId) return json({ error: 'Missing projectId, assetId, or newAssetId' }, 400)
      try {
        await relinkAsset(projectId, assetId, body.newAssetId, body.label)
        ctx.activity.audit('asset.relinked', 'system', { projectId, oldAssetId: assetId, newAssetId: body.newAssetId })
        ctx.activity.log('system', 'Relinked project asset', { taskId: projectId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = message.startsWith('Project not found') || message.startsWith('Asset not found') || message.startsWith('Asset not attached') ? 404 : 400
        return json({ error: message }, status)
      }
    }
    routeHandlers.set('PATCH /:projectId/assets/:assetId', relinkHandler)

    // DELETE /:projectId/assets/:assetId — detach asset
    const detachHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; assetId?: string }>(req).catch(() => ({} as { projectId?: string; assetId?: string }))
      const projectId = url.searchParams.get('projectId') || body.projectId
      const assetId = url.searchParams.get('assetId') || body.assetId
      if (!projectId || !assetId) return json({ error: 'Missing projectId or assetId' }, 400)
      try {
        await detachAsset(projectId, assetId)
        ctx.activity.audit('asset.detached', 'system', { projectId, assetId })
        ctx.activity.log('system', 'Detached asset from project', { taskId: projectId })
        indexProject(projectId).catch(() => {})
        return json({ ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = message.startsWith('Project not found') ? 404 : 400
        return json({ error: message }, status)
      }
    }
    routeHandlers.set('DELETE /:projectId/assets/:assetId', detachHandler)

    // POST /:projectId/ask — agent brainstorm on the turn engine (bakin#703):
    // 202 immediately, the turn streams as projects.brainstorm.* bus events
    // and persists incrementally. One turn per project (busy → 409). The
    // assembled context rides opts.runtimeContent — the transcript keeps the
    // user's clean prompt.
    routeHandlers.set('POST /:projectId/ask', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{
        projectId?: string
        prompt: string
        agent?: string
      }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      if (!projectId || !body.prompt) return json({ error: 'Missing projectId or prompt' }, 400)
      // A body id diverging from the path would silently brainstorm (and
      // mutate) a DIFFERENT project under this URL — refuse.
      if (body.projectId && body.projectId !== projectId) {
        return json({ error: 'projectId mismatch between path and body' }, 400)
      }
      const project = readProject(projectId)
      if (!project) return json({ error: 'Project not found' }, 404)
      const agentId = body.agent || await getRuntimeMainAgentId(ctx)
      const context = buildProjectBrainstormContext(await derive(project), body.prompt, { live: true })

      const result = await brainstormTurns.start(ctx, projectId, body.prompt, {
        agentId,
        runtimeContent: context,
      })
      if (result === 'not_found') return json({ error: 'Project not found' }, 404)
      if (result === 'busy') return json({ error: 'A brainstorm turn is already running for this project' }, 409)
      return json({ ok: true, streaming: true }, 202)
    })

    // POST /:projectId/ask/abort — stop the in-flight brainstorm turn.
    routeHandlers.set('POST /:projectId/ask/abort', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId')
      if (!id) return json({ error: 'Missing projectId' }, 400)
      if (!brainstormTurns.abort(id)) return json({ error: 'No brainstorm turn in flight' }, 409)
      return json({ ok: true })
    })

    /** A project counts as unread when agent activity landed after the last view. */
    function hasUnseenBrainstormReply(id: string): boolean {
      const lastAgentTs = repo.readLastAgentActivityTs(id)
      if (!lastAgentTs) return false
      const seenAt = repo.readSeen(id).lastSeenAt
      return !seenAt || lastAgentTs > seenAt
    }

    // GET /brainstorm/attention — totals for the nav badge provider:
    // unreadTotal counts PROJECTS with unseen agent replies; inflight lists
    // projects with a running turn (server truth for the working dot).
    routeHandlers.set('GET /brainstorm/attention', async () => {
      const unread = readAllProjects().filter(p => hasUnseenBrainstormReply(p.id))
      return json({
        unreadTotal: unread.length,
        inflight: brainstormTurns.listInFlight().map(t => t.key),
      })
    })

    // POST /:projectId/brainstorm/seen — viewing the brainstorm clears unread.
    routeHandlers.set('POST /:projectId/brainstorm/seen', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId')
      if (!id) return json({ error: 'Missing projectId' }, 400)
      if (!readProject(id)) return json({ error: 'Project not found' }, 404)
      repo.updateSeen(id, { lastSeenAt: new Date().toISOString() })
      return json({ ok: true })
    })

    // POST /:projectId/plan/seen — viewing the Plan tab marks the revision it
    // showed as seen (D15). Monotonic: a stale tab never rewinds the baseline.
    routeHandlers.set('POST /:projectId/plan/seen', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId')
      if (!id) return json({ error: 'Missing projectId' }, 400)
      const project = readProject(id)
      if (!project) return json({ error: 'Project not found' }, 404)
      const body = await readBody<{ revision?: unknown }>(req).catch(() => ({} as { revision?: unknown }))
      if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return json({ error: 'Missing revision', code: 'invalid_request' }, 400)
      const revision = Math.min(body.revision as number, project.planRevision)
      const seen = repo.readSeen(id)
      if (revision > seen.planSeenRevision) repo.updateSeen(id, { planSeenRevision: revision })
      return json({ ok: true, planSeenRevision: Math.max(revision, seen.planSeenRevision) })
    })

    // GET /:projectId/history — plan snapshots, oldest first (bakin#703).
    routeHandlers.set('GET /:projectId/history', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId')
      if (!id) return json({ error: 'Missing projectId' }, 400)
      if (!readProject(id)) return json({ error: 'Project not found' }, 404)
      try {
        return json({ history: repo.readPlanHistory(id) })
      } catch (error) {
        log.error('Failed to load plan history', error, { projectId: id })
        return json({ error: 'Plan history is unavailable' }, 500)
      }
    })

    // POST /:projectId/history/:index/restore — never destructive: the
    // current body becomes a snapshot before the restore lands.
    routeHandlers.set('POST /:projectId/history/:index/restore', async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId')
      const index = Number(url.searchParams.get('index'))
      const body = await readBody<{ expectedTs?: string }>(req).catch(() => ({} as { expectedTs?: string }))
      if (!id || !Number.isInteger(index) || index < 0) return json({ error: 'Missing projectId or index' }, 400)
      try {
        const { changed } = await projectService.restorePlanVersion(id, index, callerFromRequest(req), body.expectedTs)
        indexProject(id).catch(() => {})
        return json({ ok: true, changed })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = err instanceof PlanHistoryUnavailableError ? 500
          : message.startsWith('Project not found') ? 404
          : message.startsWith('History changed') ? 409
          : 400
        if (status === 500) log.error('Failed to restore plan history', err, { projectId: id })
        return json({ error: message }, status)
      }
    })

    // -----------------------------------------------------------------
    // MCP Exec Tools
    // -----------------------------------------------------------------

    ctx.registerExecTool({
      name: 'bakin_exec_projects_list',
      label: 'Listed projects',
      description: 'List all projects with optional status filter. Returns summaries with id, title, status, progress, taskCount.',
      parameters: {
        status: z.enum(['draft', 'active', 'completed', 'archived']).optional().describe('Filter by status'),
      },
      handler: async (params: Record<string, unknown>) => {
        let projects = readAllProjects()
        if (params.status) {
          projects = projects.filter(p => p.status === params.status)
        }
        const board = await boardIndex()
        return { ok: true, projects: projects.map(p => projectToSummary(deriveChecklist(p, board))) }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_get',
      label: 'Read project details',
      description: 'Get a project by ID including full spec, checklist, progress, and linked board task statuses.',
      parameters: {
        projectId: z.string().describe('Project ID'),
      },
      handler: async (params: Record<string, unknown>) => {
        const project = await projectService.reconcileLinks(params.projectId as string)
        if (!project) return { ok: false, error: `Project not found: ${params.projectId}` }
        return { ok: true, project: await resolveLinkedTaskStatuses(project) }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_create',
      label: 'Created a project',
      description: 'Create a new project with title, markdown body, and optional initial checklist items. Returns project ID and generated task item IDs.',
      parameters: {
        title: z.string().describe('Project title'),
        body: z.string().optional().describe('Markdown body (spec/plan)'),
        owner: z.string().optional().describe('Project owner'),
        tasks: z.array(z.string()).optional().describe('Initial checklist item titles'),
      },
      handler: async (params: Record<string, unknown>, agent: string) => {
        const result = await createProject({
          title: params.title as string,
          titleSource: 'agent',
          body: params.body as string | undefined,
          owner: (params.owner as string) || agent,
          tasks: params.tasks as string[] | undefined,
        })
        indexProject(result.id).catch(() => {})
        return { ok: true, ...result }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_update',
      label: 'Updated a project',
      description: 'Update a project\'s title, body, or owner. Lifecycle status (start, complete, archive) is the user\'s decision and cannot be changed by agents. A title the user typed cannot be overwritten.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        title: z.string().optional().describe('New title (refused when the user named the project)'),
        body: z.string().optional().describe('New markdown body'),
        owner: z.string().optional().describe('New owner'),
      },
      handler: async (params: Record<string, unknown>, agent: string) => {
        try {
          await updateProject(params.projectId as string, {
            title: params.title as string | undefined,
            body: params.body as string | undefined,
            owner: params.owner as string | undefined,
          }, { kind: 'agent', agentId: agent })
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_apply_plan',
      label: 'Applied a project plan',
      description: 'Apply a confirmed project plan update in one operation. Use this after the user confirms exact body/checklist changes so agents do not need shell scripts or multiple low-level calls.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        title: z.string().optional().describe('Optional new project title (refused when the user named the project)'),
        body: z.string().optional().describe('Replacement markdown body for the project plan'),
        appendBody: z.string().optional().describe('Markdown to append to the existing project body; cannot be combined with body'),
        owner: z.string().optional().describe('Optional new owner'),
        checklistItems: z.array(z.string()).optional().describe('New unchecked checklist item titles to append'),
      },
      handler: async (params: Record<string, unknown>, agent: string) => {
        try {
          const result = await applyProjectPlan(params.projectId as string, {
            title: params.title as string | undefined,
            body: params.body as string | undefined,
            appendBody: params.appendBody as string | undefined,
            owner: params.owner as string | undefined,
            checklistItems: params.checklistItems as string[] | undefined,
          }, { kind: 'agent', agentId: agent })
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true, ...result }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_add_item',
      label: 'Added project item',
      description: 'Add a new checklist item to a project.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        title: z.string().describe('Checklist item title'),
      },
      handler: async (params: Record<string, unknown>) => {
        const result = await addChecklistItem(params.projectId as string, params.title as string)
        indexProject(params.projectId as string).catch(() => {})
        return { ok: true, ...result }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_mark_item',
      label: 'Marked project item',
      description: 'Mark a standalone checklist item as checked (done) or unchecked. Steps linked to a board task complete from that task and are refused (linked_step). Returns updated progress percentage.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        taskItemId: z.string().describe('Checklist item ID (e.g., t001)'),
        checked: z.boolean().describe('true to mark as done, false to uncheck'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          await projectService.reconcileLinks(params.projectId as string)
          const result = await markChecklistItem(
            params.projectId as string,
            params.taskItemId as string,
            params.checked as boolean,
          )
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true, ...result }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message, ...(err instanceof ProjectMutationError ? { code: err.code } : {}) }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_link_item',
      label: 'Linked project item',
      description: 'Link an existing board task to a project checklist item. Use this when a task was created separately and should be associated with a project.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        taskItemId: z.string().describe('Checklist item ID'),
        taskId: z.string().describe('Board task ID to link'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          await linkChecklistItem(
            params.projectId as string,
            params.taskItemId as string,
            params.taskId as string,
          )
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_promote_item',
      label: 'Promoted project item',
      description: 'Create a NEW board task from a project checklist item and automatically link it. The task appears on the task board with the item title and projectId set.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        taskItemId: z.string().describe('Checklist item ID to promote to a board task'),
        assignee: z.string().optional().describe('Agent to assign the task to'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          const result = await promoteItemToTask(
            params.projectId as string,
            params.taskItemId as string,
            { assignee: params.assignee as string | undefined },
          )
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true, ...result }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_attach_asset',
      label: 'Attached asset to project',
      description: 'Attach an existing asset to a project by assetId. Assets provide additional context (specs, designs, docs) that agents can reference. Only summaries are included in projects_get — use asset tools to read full content when needed.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        assetId: z.string().describe('Asset id (e.g., "20260327-hero-a1b2c3d4") — stable across versions'),
        label: z.string().optional().describe('Human-readable label or summary of what this asset contains'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          await attachAsset(params.projectId as string, params.assetId as string, params.label as string | undefined)
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_detach_asset',
      label: 'Detached asset from project',
      description: 'Remove an asset reference from a project by assetId. Does not delete the asset itself.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        assetId: z.string().describe('Asset id to detach'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          await detachAsset(params.projectId as string, params.assetId as string)
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_relink_asset',
      label: 'Relinked project asset',
      description: 'Replace an attached project asset reference with another existing asset. Use this to repair missing or deleted asset references without removing the project context.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        assetId: z.string().describe('Current asset id attached to the project'),
        newAssetId: z.string().describe('Replacement asset id to attach in its place'),
        label: z.string().optional().describe('Optional replacement label. If omitted, the existing project label is preserved.'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          await relinkAsset(
            params.projectId as string,
            params.assetId as string,
            params.newAssetId as string,
            params.label as string | undefined,
          )
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_toggle_item',
      label: 'Toggled project item',
      activityDuplicate: true,
      description: 'Toggle a standalone checklist item checked/unchecked by item ID. Steps linked to a board task complete from that task and are refused (linked_step). Returns updated progress percentage.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        itemId: z.string().describe('Checklist item ID (e.g., t001)'),
        checked: z.boolean().describe('true to mark as done, false to uncheck'),
      },
      handler: async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string
        const itemId = params.itemId as string
        const checked = params.checked as boolean
        try {
          await projectService.reconcileLinks(projectId)
          const result = await markChecklistItem(projectId, itemId, checked)
          ctx.activity.audit('checklist.toggled', 'system', { projectId, checked })
          indexProject(projectId).catch(() => {})
          return { ok: true, ...result }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message, ...(err instanceof ProjectMutationError ? { code: err.code } : {}) }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_update_item',
      label: 'Updated project item',
      activityDuplicate: true,
      description: 'Update a checklist item\'s title and/or description.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        itemId: z.string().describe('Checklist item ID (e.g., t001)'),
        title: z.string().optional().describe('New title for the checklist item'),
        description: z.string().optional().describe('New description for the checklist item'),
      },
      handler: async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string
        const itemId = params.itemId as string
        try {
          await updateChecklistItem(projectId, itemId, {
            title: params.title as string | undefined,
            description: params.description as string | undefined,
          })
          ctx.activity.audit('checklist.updated', 'system', { projectId })
          indexProject(projectId).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_ask',
      label: 'Asked project question',
      activityDuplicate: true,
      description: 'Ask an agent a question about a project. Sends the project context (spec, checklist, assets) along with the message to the agent for brainstorming.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        message: z.string().describe('Question or prompt for the agent'),
        agent: z.string().optional().describe('Agent ID to ask (defaults to main)'),
      },
      handler: async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string
        const message = params.message as string
        const project = readProject(projectId)
        if (!project) return { ok: false, error: `Project not found: ${projectId}` }

        // A tool reply returns to the calling agent, not the project chat —
        // question cards would render nowhere.
        const context = buildProjectBrainstormContext(await derive(project), message, { live: false })

        try {
          const agentId = (params.agent as string) || await getRuntimeMainAgentId(ctx)
          const result = await ctx.runtime.messaging.send({ agentId, content: context })
          const reply = result.content ?? ''
          ctx.activity.audit('project.asked', 'system', { projectId, agent: agentId })
          return { ok: true, reply }
        } catch (err: unknown) {
          log.error('Agent ask failed', err)
          return { ok: false, error: (err as Error).message || 'Failed to reach agent' }
        }
      },
    })

    log.info('Projects plugin activated')
  },

  onReady() {
    void resumePendingKickoffs?.()
    const projects = activeProjectRepository?.readAllProjects() ?? []
    const byStatus: Record<string, number> = {}
    for (const p of projects) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1
    }
    log.info(`Ready — ${projects.length} projects`, byStatus)
  },

  onShutdown() {
    activeProjectRepository = null
    resumePendingKickoffs = null
    log.info('Projects plugin shutting down')
  },
}

export default projectsPlugin
