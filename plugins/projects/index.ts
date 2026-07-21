/**
 * Projects plugin — server entry point.
 * Registers API routes, exec tools, and the task-link index.
 */
import { z } from 'zod'
import { defineRoute } from '@makinbakin/sdk'
import type { BakinPlugin, PluginContext, RuntimeAgent } from '@makinbakin/sdk/types'
import { conversationThreadId } from '@makinbakin/sdk/utils'
import { createProjectRepository, projectToSummary } from './lib/parser'
import { createProjectService } from './lib/project-service'
import type { Project, ProjectBrainstormMessage, ProjectStatus } from './types'

const log = {
  info: (...args: unknown[]) => console.info('[projects]', ...args),
  warn: (...args: unknown[]) => console.warn('[projects]', ...args),
  error: (...args: unknown[]) => console.error('[projects]', ...args),
}

let activeProjectRepository: ReturnType<typeof createProjectRepository> | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readBody<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>
}

async function getRuntimeMainAgentId(ctx: PluginContext): Promise<string> {
  const agents = await ctx.runtime.agents.list()
  const main = agents.find((agent: RuntimeAgent) => agent.metadata?.main === true)
    ?? agents.find((agent: RuntimeAgent) => agent.id === 'main')
    ?? agents[0]
  return main?.id ?? 'main'
}

const PROJECT_BRAINSTORM_INSTRUCTIONS = [
  'Project brainstorm mode:',
  'This brainstorm is for maintaining and improving the project plan.',
  'Treat chat as the working conversation, but keep the project body and checklist as the durable source of truth.',
  'Default toward identifying plan updates, checklist changes, open questions, and next actions that would keep the project current.',
  'Do not edit the project body or checklist until the user explicitly asks you to update it or confirms your proposed changes.',
  'When updates are warranted, propose the exact project body and checklist changes first.',
  'After confirmation, prefer bakin_exec_projects_apply_plan for combined body and checklist updates.',
  'Invoke Bakin tools as described in your Tool access section — the exact call form depends on the active runtime.',
  'If the user asks for advice only, answer in chat and call out any optional plan update separately.',
  'If suggesting tasks, format them as a numbered list.',
].join('\n')

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

  settingsSchema: {
    fields: [
      { key: 'defaultStatus', type: 'select', label: 'Default project status', description: 'Status assigned to new projects', options: [{ value: 'active', label: 'Active' }, { value: 'planning', label: 'Planning' }, { value: 'paused', label: 'Paused' }], default: 'active' },
      { key: 'autoPromoteThreshold', type: 'number', label: 'Auto-promote threshold', description: 'Auto-promote checklist items to tasks when project has more than N unchecked items (0 = disabled)', default: 0 },
    ],
  },

  navItems: [
    { id: 'projects', label: 'Projects', icon: 'FolderKanban', href: '/projects', order: 30 },
  ],

  routes: [
    legacyRoute('GET', '/', 'List projects'),
    legacyRoute('GET', '/:projectId', 'Get project by ID'),
    legacyRoute('POST', '/', 'Create project'),
    legacyRoute('PUT', '/:projectId', 'Update project'),
    legacyRoute('DELETE', '/:projectId', 'Delete project'),
    legacyRoute('POST', '/:projectId/checklist', 'Add checklist item'),
    legacyRoute('PUT', '/:projectId/checklist/:itemId/toggle', 'Toggle checklist item'),
    legacyRoute('PUT', '/:projectId/checklist/:itemId', 'Update checklist item'),
    legacyRoute('DELETE', '/:projectId/checklist/:itemId', 'Remove checklist item'),
    legacyRoute('POST', '/:projectId/checklist/:itemId/link', 'Link checklist item to task'),
    legacyRoute('POST', '/:projectId/checklist/:itemId/promote', 'Promote item to task'),
    legacyRoute('POST', '/:projectId/assets', 'Attach asset'),
    legacyRoute('PATCH', '/:projectId/assets/:assetId', 'Relink asset reference'),
    legacyRoute('DELETE', '/:projectId/assets/:assetId', 'Detach asset'),
    legacyRoute('POST', '/:projectId/ask', 'Ask agent about project (202; streams over the plugin-event bus)'),
    legacyRoute('POST', '/:projectId/ask/abort', 'Abort the in-flight brainstorm turn'),
    legacyRoute('GET', '/brainstorm/attention', 'Brainstorm attention totals (unread + in-flight)'),
    legacyRoute('POST', '/:projectId/brainstorm/seen', 'Mark a project brainstorm as seen'),
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
      autoCheckLinkedItem,
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
      },
      payload: (key) => ({ projectId: key }),
      resolveThread: async (key) =>
        readProject(key) ? { agentId: await getRuntimeMainAgentId(ctx) } : null,
      appendRow: (key, row) => {
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
    })

    // ─── Search Content Type Registration ─────────────────────────────

    /** Convert a project to a search document */
    function projectToSearchDoc(project: Project): Record<string, unknown> {
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
          yield { key: project.id, doc: projectToSearchDoc(project) }
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
          await ctx.search.index(projectId, projectToSearchDoc(project))
        }
      } catch (err) {
        log.warn('Failed to index project', { projectId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Register task extension hooks. Core emits task lifecycle events and
    // the tasks plugin asks for generic detail enrichment; projects owns the
    // project-specific behavior behind those extension points.
    ctx.hooks.register('tasks.statusChanged', async (d: unknown) => {
      const data = d as Record<string, unknown>
      const to = String(data.to ?? '').toLowerCase()
      if (to !== 'done' && to !== 'archived') return
      const taskId = data.taskId as string | undefined
      if (taskId) await autoCheckLinkedItem(taskId)
    }, {
      label: 'Sync project task state.',
      summary: 'Updates linked project checklist items when a task moves into a completed state. Use it to keep project progress in sync with task lifecycle events.',
      hookKind: 'event',
    })
    ctx.hooks.register('tasks.enrichDetails', (d: unknown) => {
      const data = d as Record<string, unknown>
      const task = data.task as Record<string, unknown> | undefined
      const projectId = task?.projectId as string | undefined
      if (!projectId) return data

      const project = readProject(projectId)
      if (!project) return data

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
      }
    })

    // -----------------------------------------------------------------
    // API Routes (RESTful + aliases for old paths)
    // -----------------------------------------------------------------

    // GET / — list projects
    const listHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const statusFilter = url.searchParams.get('status') as ProjectStatus | null
      let projects = readAllProjects()
      if (statusFilter) projects = projects.filter(p => p.status === statusFilter)
      return json({ projects: projects.map(projectToSummary) })
    }
    routeHandlers.set('GET /', listHandler)

    // GET /:projectId — get single project
    const getHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('projectId') || url.searchParams.get('id')
      if (!id) return json({ error: 'Missing id parameter' }, 400)
      const project = readProject(id)
      if (!project) return json({ error: 'Project not found' }, 404)
      return json({
        project: {
          ...(await resolveLinkedTaskStatuses(project)),
          brainstormMessages: readBrainstormMessages(id),
          // Server-seeded in-flight flag — a remount mid-turn rehydrates the
          // streaming indicator instead of looking idle.
          brainstormStreaming: brainstormTurns.isInFlight(id),
        },
      })
    }
    routeHandlers.set('GET /:projectId', getHandler)

    // POST / — create project
    const createHandler = async (req: Request) => {
      const body = await readBody<{ title: string; body?: string; owner?: string; tasks?: string[] }>(req)
      if (!body.title) return json({ error: 'Missing title' }, 400)
      const owner = body.owner ?? await getRuntimeMainAgentId(ctx)
      const result = await createProject({ ...body, owner })
      ctx.activity.audit('created', owner, { projectId: result.id, title: body.title })
      ctx.activity.log(owner, `Created project "${body.title}"`)
      indexProject(result.id).catch(() => {})
      return json({ ok: true, ...result })
    }
    routeHandlers.set('POST /', createHandler)

    // PUT /:projectId — update project
    const updateHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ id?: string; title?: string; status?: ProjectStatus; body?: string; owner?: string }>(req)
      const id = url.searchParams.get('projectId') || body.id
      if (!id) return json({ error: 'Missing id' }, 400)
      try {
        await updateProject(id, body)
        ctx.activity.audit('updated', 'system', { projectId: id })
        ctx.activity.log('system', `Updated project ${id}`)
        indexProject(id).catch(() => {})
        return json({ ok: true })
      } catch (err: unknown) {
        return json({ error: (err as Error).message }, 400)
      }
    }
    routeHandlers.set('PUT /:projectId', updateHandler)

    // DELETE /:projectId — delete project
    const deleteHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ id?: string; deleteLinkedTasks?: boolean }>(req).catch(() => ({} as { id?: string; deleteLinkedTasks?: boolean }))
      const id = url.searchParams.get('projectId') || body.id
      if (!id) return json({ error: 'Missing id' }, 400)
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
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; title: string }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      if (!projectId || !body.title) return json({ error: 'Missing projectId or title' }, 400)
      const result = await addChecklistItem(projectId, body.title)
      ctx.activity.audit('checklist.added', 'system', { projectId })
      ctx.activity.log('system', `Added checklist item to project ${projectId}`)
      indexProject(projectId).catch(() => {})
      return json({ ok: true, ...result })
    }
    routeHandlers.set('POST /:projectId/checklist', addItemHandler)

    // PUT /:projectId/checklist/:itemId/toggle — toggle checklist item
    const toggleHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; taskItemId?: string; checked: boolean }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      const taskItemId = url.searchParams.get('itemId') || body.taskItemId
      if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
      const result = await markChecklistItem(projectId, taskItemId, body.checked)
      ctx.activity.audit('checklist.toggled', 'system', { projectId, checked: body.checked })
      ctx.activity.log('system', 'Toggled checklist item in project', { taskId: projectId })
      indexProject(projectId).catch(() => {})
      return json({ ok: true, ...result })
    }
    routeHandlers.set('PUT /:projectId/checklist/:itemId/toggle', toggleHandler)

    // PUT /:projectId/checklist/:itemId — update checklist item
    const updateItemHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; taskItemId?: string; title?: string; description?: string }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      const taskItemId = url.searchParams.get('itemId') || body.taskItemId
      if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
      await updateChecklistItem(projectId, taskItemId, { title: body.title, description: body.description })
      ctx.activity.audit('checklist.updated', 'system', { projectId })
      ctx.activity.log('system', 'Updated checklist item in project', { taskId: projectId })
      indexProject(projectId).catch(() => {})
      return json({ ok: true })
    }
    routeHandlers.set('PUT /:projectId/checklist/:itemId', updateItemHandler)

    // DELETE /:projectId/checklist/:itemId — remove checklist item
    const removeItemHandler = async (req: Request) => {
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; taskItemId?: string }>(req).catch(() => ({} as { projectId?: string; taskItemId?: string }))
      const projectId = url.searchParams.get('projectId') || body.projectId
      const taskItemId = url.searchParams.get('itemId') || body.taskItemId
      if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
      await removeChecklistItem(projectId, taskItemId)
      ctx.activity.audit('checklist.removed', 'system', { projectId })
      ctx.activity.log('system', 'Removed checklist item from project', { taskId: projectId })
      indexProject(projectId).catch(() => {})
      return json({ ok: true })
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
      const url = new URL(req.url, 'http://localhost')
      const body = await readBody<{ projectId?: string; taskItemId?: string; assignee?: string }>(req)
      const projectId = url.searchParams.get('projectId') || body.projectId
      const taskItemId = url.searchParams.get('itemId') || body.taskItemId
      if (!projectId || !taskItemId) return json({ error: 'Missing projectId or taskItemId' }, 400)
      const result = await promoteItemToTask(projectId, taskItemId, { assignee: body.assignee })
      ctx.activity.audit('checklist.promoted', 'system', { projectId })
      ctx.activity.log('system', `Promoted checklist item to task in project ${projectId}`)
      indexProject(projectId).catch(() => {})
      return json({ ok: true, ...result })
    }
    routeHandlers.set('POST /:projectId/checklist/:itemId/promote', promoteHandler)

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
      const body = await readBody<{
        projectId: string
        prompt: string
        agent?: string
      }>(req)
      if (!body.projectId || !body.prompt) return json({ error: 'Missing projectId or prompt' }, 400)
      const project = readProject(body.projectId)
      if (!project) return json({ error: 'Project not found' }, 404)
      const agentId = body.agent || await getRuntimeMainAgentId(ctx)

      const assetLines = project.assets.length > 0
        ? ['', 'Attached assets (summaries — use asset tools to read full content if needed):', ...project.assets.map(a => `- ${a.assetId}${a.label ? ` — ${a.label}` : ''}`)]
        : []

      const context = [
        `You are being asked about project "${project.title}" (id: ${project.id}, status: ${project.status}).`,
        `Progress: ${project.progress}% (${project.tasks.filter(t => t.checked).length}/${project.tasks.length} items checked)`,
        '',
        'Project spec:',
        project.body.slice(0, 3000),
        '',
        'Checklist items:',
        ...project.tasks.map(t => `- [${t.checked ? 'x' : ' '}] ${t.title}${t.taskId ? ` (linked: ${t.taskId})` : ''}`),
        ...assetLines,
        PROJECT_BRAINSTORM_INSTRUCTIONS,
        '',
        'User request:',
        body.prompt,
        '',
        'Respond concisely.',
      ].join('\n')

      const result = await brainstormTurns.start(ctx, body.projectId, body.prompt, {
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
      const rows = readBrainstormMessages(id)
      const lastAgentTs = [...rows].reverse().find(r => r.kind === 'assistant' || r.kind === 'error')?.ts
      if (!lastAgentTs) return false
      const seenAt = repo.readBrainstormSeen(id)
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
      repo.writeBrainstormSeen(id, new Date().toISOString())
      return json({ ok: true })
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
        return { ok: true, projects: projects.map(projectToSummary) }
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
        const project = readProject(params.projectId as string)
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
      description: 'Update a project\'s title, status, body, or owner. Cannot set status to "completed" if unchecked items remain.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        title: z.string().optional().describe('New title'),
        status: z.enum(['draft', 'active', 'completed', 'archived']).optional().describe('New status'),
        body: z.string().optional().describe('New markdown body'),
        owner: z.string().optional().describe('New owner'),
      },
      handler: async (params: Record<string, unknown>, agent: string) => {
        try {
          await updateProject(params.projectId as string, {
            title: params.title as string | undefined,
            status: params.status as ProjectStatus | undefined,
            body: params.body as string | undefined,
            owner: params.owner as string | undefined,
          }, agent)
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
        title: z.string().optional().describe('Optional new project title'),
        status: z.enum(['draft', 'active', 'completed', 'archived']).optional().describe('Optional new status'),
        body: z.string().optional().describe('Replacement markdown body for the project plan'),
        appendBody: z.string().optional().describe('Markdown to append to the existing project body; cannot be combined with body'),
        owner: z.string().optional().describe('Optional new owner'),
        checklistItems: z.array(z.string()).optional().describe('New unchecked checklist item titles to append'),
      },
      handler: async (params: Record<string, unknown>, agent: string) => {
        try {
          const result = await applyProjectPlan(params.projectId as string, {
            title: params.title as string | undefined,
            status: params.status as ProjectStatus | undefined,
            body: params.body as string | undefined,
            appendBody: params.appendBody as string | undefined,
            owner: params.owner as string | undefined,
            checklistItems: params.checklistItems as string[] | undefined,
          }, agent)
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true, ...result }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
        }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_delete',
      label: 'Deleted a project',
      description: 'Delete a project by ID.',
      parameters: {
        projectId: z.string().describe('Project ID'),
      },
      handler: async (params: Record<string, unknown>, agent: string) => {
        try {
          await deleteProject(params.projectId as string, agent)
          ctx.search.remove(params.projectId as string).catch(() => {})
          return { ok: true }
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
      description: 'Mark a checklist item as checked (done) or unchecked. Returns updated progress percentage.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        taskItemId: z.string().describe('Checklist item ID (e.g., t001)'),
        checked: z.boolean().describe('true to mark as done, false to uncheck'),
      },
      handler: async (params: Record<string, unknown>) => {
        const result = await markChecklistItem(
          params.projectId as string,
          params.taskItemId as string,
          params.checked as boolean,
        )
        indexProject(params.projectId as string).catch(() => {})
        return { ok: true, ...result }
      },
    })

    ctx.registerExecTool({
      name: 'bakin_exec_projects_remove_item',
      label: 'Removed project item',
      description: 'Remove a checklist item from a project.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        taskItemId: z.string().describe('Checklist item ID to remove'),
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          await removeChecklistItem(params.projectId as string, params.taskItemId as string)
          indexProject(params.projectId as string).catch(() => {})
          return { ok: true }
        } catch (err: unknown) {
          return { ok: false, error: (err as Error).message }
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
      description: 'Toggle a checklist item checked/unchecked by item ID. Returns updated progress percentage.',
      parameters: {
        projectId: z.string().describe('Project ID'),
        itemId: z.string().describe('Checklist item ID (e.g., t001)'),
        checked: z.boolean().describe('true to mark as done, false to uncheck'),
      },
      handler: async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string
        const itemId = params.itemId as string
        const checked = params.checked as boolean
        const result = await markChecklistItem(projectId, itemId, checked)
        ctx.activity.audit('checklist.toggled', 'system', { projectId, checked })
        indexProject(projectId).catch(() => {})
        return { ok: true, ...result }
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

        const assetLines = project.assets.length > 0
          ? ['', 'Attached assets (summaries — use asset tools to read full content if needed):', ...project.assets.map(a => `- ${a.assetId}${a.label ? ` — ${a.label}` : ''}`)]
          : []

        const context = [
          `You are being asked about project "${project.title}" (id: ${project.id}, status: ${project.status}).`,
          `Progress: ${project.progress}% (${project.tasks.filter(t => t.checked).length}/${project.tasks.length} items checked)`,
          '',
          'Project spec:',
          project.body.slice(0, 3000),
          '',
          'Checklist items:',
          ...project.tasks.map(t => `- [${t.checked ? 'x' : ' '}] ${t.title}${t.taskId ? ` (linked: ${t.taskId})` : ''}`),
          ...assetLines,
          '',
          'User request:',
          message,
          '',
          'Respond concisely. If suggesting tasks, format them as a numbered list.',
        ].join('\n')

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
    const projects = activeProjectRepository?.readAllProjects() ?? []
    const byStatus: Record<string, number> = {}
    for (const p of projects) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1
    }
    log.info(`Ready — ${projects.length} projects`, byStatus)
  },

  onShutdown() {
    activeProjectRepository = null
    log.info('Projects plugin shutting down')
  },
}

export default projectsPlugin
