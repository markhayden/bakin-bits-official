import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { mock } from 'bun:test'
import type {
  AgentRuntimeAdapter,
  APIRoute,
  AssetFileRef,
  BakinPlugin,
  ExecToolDefinition,
  FileBackedContentTypeDefinition,
  PluginContext,
  PluginHealthCheckInput,
  RuntimeChatChunk,
  SearchQueryParams,
  SearchResponse,
  SearchResult,
  StorageAdapter,
  StorageStat,
  Task,
  TaskCreateInput,
  TaskService,
  WorkflowDefinitionInput,
} from '@bakin/sdk/types'

export class MarkdownStorageAdapter implements StorageAdapter {
  constructor(private readonly root: string) {}

  private resolve(path: string): string {
    return join(this.root, path)
  }

  read(path: string): string | null {
    try {
      return readFileSync(this.resolve(path), 'utf-8')
    } catch {
      return null
    }
  }

  write(path: string, content: string): void {
    const full = this.resolve(path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }

  append(path: string, content: string): void {
    const full = this.resolve(path)
    mkdirSync(dirname(full), { recursive: true })
    appendFileSync(full, content, 'utf-8')
  }

  exists(path: string): boolean {
    return existsSync(this.resolve(path))
  }

  readAll(): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (dir: string, prefix = '') => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full, rel)
        else if (/\.(md|json|jsonl)$/.test(entry.name)) out[rel] = readFileSync(full, 'utf-8')
      }
    }
    walk(this.root)
    return out
  }

  list(path = ''): string[] {
    const full = this.resolve(path)
    if (!existsSync(full) || !statSync(full).isDirectory()) return []
    return readdirSync(full).sort()
  }

  remove(path: string): void {
    rmSync(this.resolve(path), { recursive: true, force: true })
  }

  rename(from: string, to: string): void {
    const src = this.resolve(from)
    const dest = this.resolve(to)
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(src, dest)
  }

  stat(path: string): StorageStat | null {
    const full = this.resolve(path)
    if (!existsSync(full)) return null
    const stat = statSync(full)
    return {
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
    }
  }

  readJson<T = unknown>(path: string): T | null {
    const text = this.read(path)
    return text === null ? null : JSON.parse(text) as T
  }

  writeJson(path: string, value: unknown): void {
    this.write(path, JSON.stringify(value, null, 2))
  }

  searchPath(path: string): string {
    return path.replaceAll('\\', '/')
  }
}

export class BakinEventBus {
  private handlers = new Map<string, Set<(event: string, data: Record<string, unknown>) => void>>()

  constructor(..._args: unknown[]) {}

  emit(event: string, data: Record<string, unknown> = {}): void {
    for (const [pattern, handlers] of this.handlers.entries()) {
      if (pattern === event || pattern === '*') {
        for (const handler of handlers) handler(event, data)
      }
    }
  }

  on(pattern: string, handler: (event: string, data: Record<string, unknown>) => void): () => void {
    const handlers = this.handlers.get(pattern) ?? new Set()
    handlers.add(handler)
    this.handlers.set(pattern, handlers)
    return () => handlers.delete(handler)
  }

  once(pattern: string, handler: (event: string, data: Record<string, unknown>) => void): () => void {
    const off = this.on(pattern, (event, data) => {
      off()
      handler(event, data)
    })
    return off
  }
}

export function createMockRuntimeAdapter(): AgentRuntimeAdapter {
  return {
    agents: {
      list: mock(async () => [{ id: 'main', name: 'Main', metadata: { main: true } }]),
      get: mock(async (agentId: string) => ({ id: agentId, name: agentId === 'main' ? 'Main' : agentId })),
    },
    messaging: {
      send: mock(async () => ({ id: 'msg-test', content: 'ok' })),
      stream: mock(async function* (): AsyncIterable<RuntimeChatChunk> {
        yield { type: 'text', content: 'ok' }
        yield { type: 'done' }
      }),
    },
    channels: {
      list: mock(async () => []),
      sendMessage: mock(async ({ channels }: { channels: string[] }) => ({
        deliveries: channels.map(channelId => ({ channelId, ref: `msg-${channelId}`, renderedAt: new Date().toISOString() })),
      })),
      deliverContent: mock(async ({ channels }: { channels: string[] }) => ({
        deliveries: channels.map(channelId => ({ channelId, ref: `content-${channelId}`, renderedAt: new Date().toISOString() })),
      })),
    },
    cron: {
      list: mock(async () => []),
      get: mock(async () => null),
      create: mock(async (input) => ({ id: input.id ?? 'job-test', enabled: input.enabled ?? true, metadata: {}, ...input })),
      update: mock(async (id, patch) => ({ id, name: 'Job', schedule: '* * * * *', command: 'noop', enabled: true, ...patch })),
      remove: mock(async () => {}),
      runNow: mock(async (id) => ({ id: `run-${id}`, jobId: id, status: 'succeeded' as const })),
      listRuns: mock(async () => []),
    },
  }
}

function createEmptyTask(input: TaskCreateInput): Task {
  const now = new Date().toISOString()
  return {
    id: input.id ?? `task-${Math.random().toString(36).slice(2, 10)}`,
    title: input.title,
    description: input.description,
    agent: input.agent,
    createdBy: input.createdBy,
    checked: false,
    column: input.column ?? 'todo',
    date: input.date,
    availableAt: input.availableAt,
    dueAt: input.dueAt,
    source: input.source,
    workflowId: input.workflowId,
    skipWorkflowReason: input.skipWorkflowReason,
    projectId: input.projectId,
    parentId: input.parentId,
    createdAt: now,
    updatedAt: now,
    log: [],
  }
}

export function createMockBakinTaskStore(seed: Task[] = []): TaskService {
  const tasks = new Map(seed.map(task => [task.id, structuredClone(task)]))

  return {
    create: mock(async (input) => {
      const task = createEmptyTask(input)
      tasks.set(task.id, structuredClone(task))
      return structuredClone(task)
    }),
    update: mock(async (id, patch) => {
      const current = tasks.get(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
      tasks.set(id, structuredClone(next))
      return structuredClone(next)
    }),
    move: mock(async (id, column) => {
      const current = tasks.get(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      const next = { ...current, column, updatedAt: new Date().toISOString() }
      tasks.set(id, structuredClone(next))
      return structuredClone(next)
    }),
    remove: mock(async (id) => {
      tasks.delete(id)
    }),
    get: mock(async (id) => {
      const task = tasks.get(id)
      return task ? structuredClone(task) : null
    }),
    list: mock(async (filter = {}) => Array.from(tasks.values())
      .filter(task => !filter.column || task.column === filter.column)
      .filter(task => !filter.agent || task.agent === filter.agent)
      .filter(task => !filter.projectId || task.projectId === filter.projectId)
      .map(task => structuredClone(task))),
    appendLog: mock(async (id, entry) => {
      const current = tasks.get(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      current.log = [...(current.log ?? []), entry]
      current.updatedAt = new Date().toISOString()
    }),
  }
}

export interface ActivatedPlugin {
  ctx: PluginContext
  routes: APIRoute[]
  execTools: ExecToolDefinition[]
  seedResults: (results: SearchResult[], aggregations?: SearchResponse['aggregations']) => void
  fileBackedContentTypes: FileBackedContentTypeDefinition[]
}

export function createTestContext(pluginId: string, testDir: string): ActivatedPlugin {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

  const routes: APIRoute[] = []
  const execTools: ExecToolDefinition[] = []
  const fileBackedContentTypes: FileBackedContentTypeDefinition[] = []
  const storage = new MarkdownStorageAdapter(testDir)
  const events = new BakinEventBus()
  let seededResults: SearchResult[] = []
  let seededAggregations: SearchResponse['aggregations'] = undefined

  let searchRouteRegistered = false
  const maybeAutoRegisterSearchRoute = () => {
    if (searchRouteRegistered) return
    searchRouteRegistered = true
    routes.push({
      path: '/search',
      method: 'GET',
      description: `Search ${pluginId}`,
      handler: async (req: Request) => {
        const url = new URL(req.url, 'http://localhost')
        const q = url.searchParams.get('q')
        if (!q) return Response.json({ error: 'Missing ?q= parameter' }, { status: 400 })
        const result = await ctx.search.query({
          q,
          limit: Number(url.searchParams.get('limit')) || undefined,
          offset: Number(url.searchParams.get('offset')) || undefined,
          facets: url.searchParams.get('facets')?.split(',').filter(Boolean),
        })
        return Response.json(result)
      },
    })
  }

  const ctx: PluginContext = {
    storage,
    events,
    pluginId,
    runtime: createMockRuntimeAdapter(),
    tasks: createMockBakinTaskStore(),
    assets: {
      getByFilename: mock(async () => null),
      list: mock(async () => []),
      exists: mock(async () => false),
      fileRef: mock(async (filename: string): Promise<AssetFileRef> => ({ kind: 'asset', filename })),
    },
    registerNav: mock(),
    registerRoute: route => routes.push(route),
    registerSlot: mock(),
    registerExecTool: tool => execTools.push(tool),
    registerSkill: mock(),
    registerWorkflow: mock((_def: WorkflowDefinitionInput) => {}),
    registerNodeType: mock((def) => `${pluginId}.${def.kind}`),
    registerNotificationChannel: mock((def) => `${pluginId}.${def.id}`),
    registerHealthCheck: mock((def: PluginHealthCheckInput) => `${pluginId}.${def.id}`),
    watchFiles: mock(),
    getSettings: (() => ({})) as PluginContext['getSettings'],
    updateSettings: mock(),
    activity: {
      log: mock(),
      audit: mock(),
    },
    search: {
      registerContentType: mock(() => maybeAutoRegisterSearchRoute()),
      registerFileBackedContentType: mock((def: FileBackedContentTypeDefinition) => {
        fileBackedContentTypes.push(def)
        maybeAutoRegisterSearchRoute()
      }),
      index: mock(async () => {}),
      remove: mock(async () => {}),
      transform: mock(async () => {}),
      query: mock(async (params: SearchQueryParams) => ({
        results: seededResults,
        aggregations: seededAggregations,
        meta: {
          query: params.q,
          total: seededResults.length,
          took_ms: 0,
          source: 'fallback' as const,
        },
      })),
    },
    hooks: {
      register: mock(() => () => {}),
      call: mock(async <T>(_name: string, data: T): Promise<T> => data) as PluginContext['hooks']['call'],
      callAll: mock(async () => {}),
      has: mock(() => false),
      invoke: mock(async () => undefined),
    },
  }

  return {
    ctx,
    routes,
    execTools,
    fileBackedContentTypes,
    seedResults: (results, aggregations) => {
      seededResults = results
      seededAggregations = aggregations
    },
  }
}

export async function activatePlugin(plugin: BakinPlugin, testDir: string): Promise<ActivatedPlugin> {
  const activated = createTestContext(plugin.id, testDir)
  await plugin.activate(activated.ctx)
  return activated
}

export function findRoute(routes: APIRoute[], method: string, path: string): APIRoute | undefined {
  return routes.find(route => route.method === method && route.path === path)
}

export function findTool(tools: ExecToolDefinition[], name: string): ExecToolDefinition | undefined {
  return tools.find(tool => tool.name === name)
}

export function makeRequest(path: string, opts: { method?: string; body?: unknown; searchParams?: Record<string, string> } = {}): Request {
  const url = new URL(`http://localhost${path}`)
  for (const [key, value] of Object.entries(opts.searchParams ?? {})) url.searchParams.set(key, value)
  const init: RequestInit = { method: opts.method ?? 'GET' }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return new Request(url, init)
}

export async function callRoute(
  route: APIRoute,
  ctx: PluginContext,
  opts: { path?: string; body?: unknown; searchParams?: Record<string, string>; rawResponse?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const req = makeRequest(opts.path ?? route.path, {
    method: route.method,
    body: opts.body,
    searchParams: opts.searchParams,
  })
  const response = await route.handler(req, ctx)
  if (opts.rawResponse) return { status: response.status, body: {}, response }
  let body: Record<string, unknown> = {}
  try {
    body = await response.json()
  } catch {
    // Not every route returns JSON.
  }
  return { status: response.status, body, response }
}

export async function callSearchRoute(
  activated: ActivatedPlugin,
  q: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = findRoute(activated.routes, 'GET', '/search')
  if (!route) throw new Error('Activated plugin has no /search route')
  return callRoute(route, activated.ctx, { searchParams: { q, ...extra } })
}

export async function callTool(
  tool: ExecToolDefinition,
  params: Record<string, unknown>,
  agent = 'test-agent',
): Promise<Record<string, unknown>> {
  return tool.handler(params, agent)
}
