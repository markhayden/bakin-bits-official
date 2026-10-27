import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { mock } from 'bun:test'
import type {
  AgentRuntimeAdapter,
  APIRoute,
  BakinPlugin,
  ExecToolDefinition,
  FileBackedContentTypeDefinition,
  PluginApproval,
  PluginApprovalOption,
  PluginApprovalsAPI,
  PluginContext,
  PluginGateHandler,
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
} from '@makinbakin/sdk/types'


// ---------------------------------------------------------------------------
// Conversation turn engine (#703) — functional minimum of the host engine so
// route tests exercise genuine background-turn lifecycle: slot reservation,
// incremental recorder persistence, bus events, abort/error rows, metering
// capture. Mirrors src/core/conversation-turns.ts in the bakin repo.
// ---------------------------------------------------------------------------
import { createTurnRecorder } from '@makinbakin/sdk/utils'

type TurnConfig = Record<string, any>
type TurnCtx = { runtime: any; events: { emit: (event: string, data?: Record<string, unknown>) => void } }

function createTestTurnService(config: TurnConfig, meteredTurns: Array<Record<string, unknown>>) {
  const inflight = new Map<string, { promise: Promise<unknown>; controller: AbortController; agentId: string; turnId: string; startedAt: number }>()
  const previews = new Map<string, string>()
  // Out-of-turn rows (appendExternal): queued while a turn runs, flushed at
  // slot release before the next admission — the engine's contract.
  type Batch = { rows: any[]; notice?: Record<string, unknown>; resolve: () => void; reject: (err: unknown) => void }
  const pending = new Map<string, Batch[]>()

  const writeBatch = async (ctx: TurnCtx, key: string, batch: Omit<Batch, 'resolve' | 'reject'>) => {
    for (const row of batch.rows) await config.appendRow(key, row)
    if (config.events.appended) ctx.events.emit(config.events.appended, { ...config.payload(key), ...(batch.notice ? { notice: batch.notice } : {}) })
  }

  const flushPending = async (ctx: TurnCtx, key: string) => {
    const batches = pending.get(key) ?? []
    pending.delete(key)
    for (const batch of batches) {
      try {
        await writeBatch(ctx, key, batch)
        batch.resolve()
      } catch (err) {
        batch.reject(err)
      }
    }
  }

  const runTurn = async (ctx: TurnCtx, key: string, agentId: string, content: string, controller: AbortController, turnId: string, opts?: Record<string, any>) => {
    const recorder = createTurnRecorder({ turnId })
    const persist = async (rows: any[]) => {
      for (const row of rows) {
        try { await config.appendRow(key, row) } catch { /* mirrors the engine: persistence never throws */ }
      }
    }
    let assistantText = ''
    let doneUsage: unknown
    try {
      for await (const chunk of ctx.runtime.messaging.stream({
        agentId,
        content: opts?.runtimeContent ?? (config.framing ? `${content}\n\n${config.framing}` : content),
        threadId: config.threadId(key, agentId),
        signal: controller.signal,
        ...(config.ephemeral ? { ephemeral: true } : {}),
      })) {
        try { config.hooks?.onChunk?.(key, chunk) } catch { /* tap never kills the turn */ }
        if (chunk.type === 'text' || chunk.type === 'tool' || chunk.type === 'status') {
          ctx.events.emit(config.events.chunk, {
            ...config.payload(key),
            agentId,
            chunk: { type: chunk.type, content: chunk.content, data: chunk.data, ...(chunk.type === 'text' && chunk.format ? { format: chunk.format } : {}) },
          })
        }
        if (chunk.type === 'error') {
          const kind = typeof chunk.data?.kind === 'string' ? chunk.data.kind : undefined
          throw Object.assign(new Error(chunk.content || 'runtime stream error'), { kind })
        }
        if (chunk.type === 'text') {
          assistantText += chunk.content
          previews.set(key, assistantText)
        }
        if (chunk.type === 'done') doneUsage = chunk.usage
        recorder.ingest(chunk)
        await persist(recorder.drain())
      }
      await persist(recorder.finish())
      const aborted = controller.signal.aborted
      if (aborted) await persist([{ kind: 'aborted', ts: new Date().toISOString(), turnId }])
      try { await config.hooks?.onTurnComplete?.({ key, aborted }) } catch { /* mirrors the engine: never throws */ }
      if (config.metering) {
        meteredTurns.push({ runId: config.metering.runId(key, turnId), workClass: config.metering.workClass, agent: agentId, turnId, usage: doneUsage })
      }
      ctx.events.emit(config.events.done, {
        ...config.payload(key),
        agentId,
        ...(assistantText ? { preview: assistantText.trim().split('\n')[0]?.slice(0, 140) ?? '' } : {}),
        ...(aborted ? { aborted: true } : {}),
      })
      return { aborted, errored: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const kind = err && typeof err === 'object' && 'kind' in err ? (err as { kind?: string }).kind : undefined
      await persist(recorder.finish())
      await persist([{ kind: 'error', ts: new Date().toISOString(), turnId, message, ...(kind ? { errorKind: kind } : {}) }])
      ctx.events.emit(config.events.error, { ...config.payload(key), agentId, message, ...(kind ? { kind } : {}) })
      return { aborted: false, errored: true }
    }
  }

  return {
    async start(ctx: TurnCtx, key: string, content: string, opts?: Record<string, any>) {
      const thread = await config.resolveThread(key)
      if (!thread) return 'not_found'
      if (inflight.has(key)) return 'busy'
      const controller = new AbortController()
      const turnId = `turn-${Math.random().toString(36).slice(2, 10)}`
      const agentId = opts?.agentId ?? thread.agentId
      const entry = { promise: Promise.resolve() as Promise<unknown>, controller, agentId, turnId, startedAt: Date.now() }
      inflight.set(key, entry)
      previews.set(key, '')
      if (!content.trim() && opts?.attachments?.length) content = 'See the attached image.'
      try {
        await config.appendRow(key, { kind: 'user', ts: new Date().toISOString(), content, ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) })
      } catch {
        inflight.delete(key)
        return 'not_found'
      }
      if (config.events.started) ctx.events.emit(config.events.started, { ...config.payload(key), agentId })
      entry.promise = runTurn(ctx, key, agentId, content, controller, turnId, opts)
        .finally(() => { inflight.delete(key); previews.delete(key) })
        .then(async (outcome) => {
          await flushPending(ctx, key)
          return config.hooks?.onSettled?.({ ctx, key, outcome })
        })
      return 'accepted'
    },
    abort(key: string) {
      const turn = inflight.get(key)
      if (!turn) return false
      turn.controller.abort()
      return true
    },
    isInFlight: (key: string) => inflight.has(key),
    inflightPreview: (key: string) => (inflight.has(key) ? (previews.get(key) ?? '') : null),
    waitFor: async (key: string) => { await (inflight.get(key)?.promise ?? Promise.resolve()) },
    listInFlight: () => [...inflight.entries()].map(([key, t]) => ({ key, agentId: t.agentId, turnId: t.turnId, startedAt: t.startedAt })),
    async appendExternal(ctx: TurnCtx, key: string, rows: any[], notice?: Record<string, unknown>) {
      const batch = { rows: structuredClone(rows), ...(notice ? { notice: structuredClone(notice) } : {}) }
      if (inflight.has(key)) {
        let resolve!: () => void
        let reject!: (err: unknown) => void
        const written = new Promise<void>((res, rej) => { resolve = res; reject = rej })
        // A rejection nobody awaited must not crash the test run.
        written.catch(() => {})
        pending.set(key, [...(pending.get(key) ?? []), { ...batch, resolve, reject }])
        return { status: 'queued' as const, written }
      }
      await writeBatch(ctx, key, batch)
      return { status: 'appended' as const, written: Promise.resolve() }
    },
  }
}

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

const isDoneColumn = (column: string) => column === 'done' || column === 'archived'

/** The public shape, as the host's toPluginTask projects it: `checked` is derived from the column. */
const toPublicTask = (task: Task): Task => structuredClone({ ...task, checked: isDoneColumn(task.column) })

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
    ...(input.tags?.length ? { tags: [...input.tags] } : {}),
    parentId: input.parentId,
    createdAt: now,
    updatedAt: now,
    log: [],
  }
}

export interface TaskStatusChange {
  taskId: string
  title: string
  from: string
  to: string
  task: Task
}

/**
 * Mirrors the host's plugin task service: duplicate ids are refused, `checked`
 * is derived from the column (a `checked` patch is a column move), and every
 * real column change notifies `onStatusChanged` exactly once, after the write
 * and off the writer's stack — the host's `tasks.statusChanged` chokepoint.
 */
export function createMockBakinTaskStore(
  seed: Task[] = [],
  opts: { onStatusChanged?: (change: TaskStatusChange) => void | Promise<void> } = {},
): TaskService {
  const tasks = new Map(seed.map(task => [task.id, structuredClone(task)]))

  const write = (current: Task, patch: Partial<Task>): Task => {
    const next: Task = { ...current, ...patch, updatedAt: new Date().toISOString() }
    if ('tags' in patch && !patch.tags?.length) delete next.tags
    tasks.set(next.id, structuredClone(next))
    if (next.column !== current.column && opts.onStatusChanged) {
      const change = { taskId: next.id, title: next.title, from: current.column, to: next.column, task: toPublicTask(next) }
      void Promise.resolve().then(() => opts.onStatusChanged?.(change))
    }
    return toPublicTask(next)
  }

  return {
    create: mock(async (input) => {
      if (input.id && tasks.has(input.id)) throw new Error(`Task already exists: ${input.id}`)
      const task = createEmptyTask(input)
      tasks.set(task.id, structuredClone(task))
      return toPublicTask(task)
    }),
    update: mock(async (id, patch) => {
      const current = tasks.get(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      const { checked, ...rest } = patch
      return write(current, { ...rest, ...(checked !== undefined ? { column: checked ? 'done' : 'todo' } : {}) })
    }),
    move: mock(async (id, column) => {
      const current = tasks.get(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      return write(current, { column })
    }),
    remove: mock(async (id) => {
      tasks.delete(id)
    }),
    get: mock(async (id) => {
      const task = tasks.get(id)
      return task ? toPublicTask(task) : null
    }),
    list: mock(async (filter = {}) => Array.from(tasks.values())
      .filter(task => !filter.column || task.column === filter.column)
      .filter(task => !filter.agent || task.agent === filter.agent)
      .filter(task => !filter.projectId || task.projectId === filter.projectId)
      .map(toPublicTask)),
    appendLog: mock(async (id, entry) => {
      const current = tasks.get(id)
      if (!current) throw new Error(`Task not found: ${id}`)
      current.log = [...(current.log ?? []), entry]
      current.updatedAt = new Date().toISOString()
    }),
  }
}

// ---------------------------------------------------------------------------
// ctx.approvals (spec D26) — the host's namespacing + resolve rules over an
// in-memory store. Mirrors packages/core/src/approvals/plugin-api.ts and its
// memory backend in the bakin repo (those are internal, not on the SDK).
// ---------------------------------------------------------------------------

export class ApprovalRefusal extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message)
    this.name = 'ApprovalRefusal'
  }
}

const DEFAULT_GATE_OPTIONS: PluginApprovalOption[] = [
  { id: 'approve', label: 'Approve', variant: 'primary' },
  { id: 'reject', label: 'Reject', variant: 'destructive' },
]
const OPTION_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface TestApprovals {
  api: PluginApprovalsAPI
  /**
   * Decide like the operator: runs the registered gate (a refusal leaves the
   * approval pending and rethrows), then records the decision. A reject needs
   * a reason, as on the host's default settings.
   */
  resolve(approvalId: string, option: string, comment?: string): Promise<PluginApproval>
  /** Every record, decided or not — for assertions. */
  all(): PluginApproval[]
}

export function createTestApprovals(pluginId: string): TestApprovals {
  const prefix = `${pluginId}:`
  const records = new Map<string, PluginApproval>()
  const gates = new Map<string, PluginGateHandler>()
  const resolving = new Set<string>()
  const text = (field: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`ctx.approvals.request: ${field} is required`)
    return value
  }
  const validOptions = (options: PluginApprovalOption[]) => {
    if (options.length > 10) throw new Error('ctx.approvals.request: at most 10 options')
    const seen = new Set<string>()
    for (const o of options) {
      if (!OPTION_ID.test(o.id)) throw new Error(`ctx.approvals.request: option id "${o.id}" is not transport-safe`)
      if (seen.has(o.id)) throw new Error(`ctx.approvals.request: option id "${o.id}" is offered twice`)
      if (!o.label?.trim()) throw new Error(`ctx.approvals.request: option "${o.id}" needs a label`)
      seen.add(o.id)
    }
    return options
  }

  const api: PluginApprovalsAPI = {
    registerGate(gateKind, handler) {
      text('gateKind', gateKind)
      gates.set(gateKind, handler)
      return () => { if (gates.get(gateKind) === handler) gates.delete(gateKind) }
    },
    request(input) {
      const approvalId = text('approvalId', input.approvalId)
      if (!approvalId.startsWith(prefix) || approvalId.length === prefix.length) {
        throw new Error(`ctx.approvals.request: approvalId must start with "${prefix}" — got "${approvalId}"`)
      }
      const existing = records.get(approvalId)
      if (existing) return structuredClone(existing)
      const record: PluginApproval = {
        approvalId,
        gateKind: text('gateKind', input.gateKind),
        entityId: text('entityId', input.entityId),
        taskId: text('taskId', input.taskId),
        status: 'pending',
        title: text('title', input.title),
        summary: input.summary ?? '',
        options: structuredClone(input.options?.length ? validOptions(input.options) : DEFAULT_GATE_OPTIONS),
        createdAt: new Date().toISOString(),
      }
      records.set(approvalId, record)
      return structuredClone(record)
    },
    async cancel(approvalId) {
      const record = records.get(approvalId)
      if (!record) return null
      if (record.status === 'pending') {
        records.set(approvalId, { ...record, status: 'cancelled', resolvedAt: new Date().toISOString() })
      }
      return structuredClone(records.get(approvalId)!)
    },
    get: (approvalId) => {
      const record = records.get(approvalId)
      return record ? structuredClone(record) : null
    },
    listPending: (filter = {}) => [...records.values()]
      .filter(r => r.status === 'pending')
      .filter(r => !filter.entityId || r.entityId === filter.entityId)
      .filter(r => !filter.gateKind || r.gateKind === filter.gateKind)
      .map(r => structuredClone(r)),
    refusal: (message, status = 409) => new ApprovalRefusal(message, status),
  }

  return {
    api,
    all: () => [...records.values()].map(r => structuredClone(r)),
    async resolve(approvalId, option, comment) {
      const record = records.get(approvalId)
      if (!record || record.status !== 'pending') throw new Error(`No pending approval "${approvalId}"`)
      const gate = gates.get(record.gateKind)
      if (!gate) throw new Error(`No gate registered for ${pluginId}/${record.gateKind}`)
      if (!record.options.some(o => o.id === option)) throw new ApprovalRefusal(`"${option}" is not an option on this approval`, 400)
      if (option === 'reject' && !comment?.trim()) throw new ApprovalRefusal('A reject reason is required', 400)
      if (resolving.has(approvalId)) throw new Error(`Approval "${approvalId}" is already being resolved`)
      resolving.add(approvalId)
      const respondedAt = new Date().toISOString()
      try {
        await gate.onResolve(structuredClone(record), { option, ...(comment ? { comment } : {}), respondedAt, decidedBy: 'Declared in UI' })
      } finally {
        resolving.delete(approvalId)
      }
      // The host's compare-and-set: the decision lands only on a still-pending record.
      const current = records.get(approvalId)
      if (current?.status !== 'pending') throw new Error(`Approval "${approvalId}" is no longer pending (${current?.status ?? 'deleted'})`)
      const resolved: PluginApproval = {
        ...current,
        status: option === 'reject' ? 'rejected' : 'approved',
        resolvedAt: respondedAt,
        response: { option, respondedAt, decidedBy: 'Declared in UI', ...(comment !== undefined ? { comment } : {}) },
      }
      records.set(approvalId, resolved)
      return structuredClone(resolved)
    },
  }
}

export interface ActivatedPlugin {
  ctx: PluginContext
  routes: APIRoute[]
  execTools: ExecToolDefinition[]
  seedResults: (results: SearchResult[], aggregations?: SearchResponse['aggregations']) => void
  fileBackedContentTypes: FileBackedContentTypeDefinition[]
  /** Turns metered through declarative ctx.conversations metering (#703). */
  meteredTurns: Array<Record<string, unknown>>
  /** The operator's side of ctx.approvals (resolve, inspect). */
  approvals: TestApprovals
}

export function createTestContext(pluginId: string, testDir: string): ActivatedPlugin {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

  const routes: APIRoute[] = []
  const execTools: ExecToolDefinition[] = []
  const fileBackedContentTypes: FileBackedContentTypeDefinition[] = []
  const storage = new MarkdownStorageAdapter(testDir)
  const events = new BakinEventBus()
  const meteredTurns: Array<Record<string, unknown>> = []
  const approvals = createTestApprovals(pluginId)
  // A working hook registry: what a plugin registers is what callAll reaches
  // (the task store fires tasks.statusChanged through it, like the host).
  const hookHandlers = new Map<string, Array<(data: unknown) => unknown>>()
  const callAll = async (name: string, data: unknown) => {
    // Like the host registry: one failing handler never stops the others.
    for (const handler of hookHandlers.get(name) ?? []) {
      try { await handler(data) } catch { /* the host logs and continues */ }
    }
  }
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
    tasks: createMockBakinTaskStore([], { onStatusChanged: change => ctx.hooks.callAll('tasks.statusChanged', { ...change }) }),
    assets: {
      createAsset: mock(async () => ({ assetId: 'test-asset', version: 1 })),
      getAsset: mock(async () => null),
      addVersion: mock(async () => ({ assetId: 'test-asset', version: 2 })),
      addExport: mock(async () => ({ name: 'export', file: 'exports/export.jpg' })),
      resolveVersionFile: mock(async (assetId: string) => ({ absPath: `/store/${assetId}/v1.png`, mimeType: 'image/png', version: 1 })),
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
    log: {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
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
      register: mock((name: string, handler: (data: unknown) => unknown) => {
        hookHandlers.set(name, [...(hookHandlers.get(name) ?? []), handler])
        return () => hookHandlers.set(name, (hookHandlers.get(name) ?? []).filter(h => h !== handler))
      }) as unknown as PluginContext['hooks']['register'],
      call: mock(async <T>(_name: string, data: T): Promise<T> => data) as PluginContext['hooks']['call'],
      callAll: mock(callAll) as unknown as PluginContext['hooks']['callAll'],
      has: mock(() => false),
      invoke: mock(async () => undefined),
    },
    conversations: {
      createTurnService: (config) => createTestTurnService(config as unknown as TurnConfig, meteredTurns) as ReturnType<PluginContext['conversations']['createTurnService']>,
    },
    approvals: approvals.api,
  }

  return {
    ctx,
    routes,
    execTools,
    fileBackedContentTypes,
    meteredTurns,
    approvals,
    seedResults: (results, aggregations) => {
      seededResults = results
      seededAggregations = aggregations
    },
  }
}

export async function activatePlugin(plugin: BakinPlugin, testDir: string): Promise<ActivatedPlugin> {
  const activated = createTestContext(plugin.id, testDir)
  // Declarative routes (host #642: the only route style) are collected from
  // the plugin object the way the host registry does; activate() may still
  // fill late-binding handler maps afterwards.
  for (const route of plugin.routes ?? []) activated.routes.push(route as APIRoute)
  await plugin.activate(activated.ctx)
  return activated
}

export function findRoute(routes: APIRoute[], method: string, path: string): APIRoute | undefined {
  return routes.find(route => route.method === method && route.path === path)
}

export function findTool(tools: ExecToolDefinition[], name: string): ExecToolDefinition | undefined {
  return tools.find(tool => tool.name === name)
}

export function makeRequest(path: string, opts: { method?: string; body?: unknown; searchParams?: Record<string, string>; headers?: Record<string, string> } = {}): Request {
  const url = new URL(`http://localhost${path}`)
  for (const [key, value] of Object.entries(opts.searchParams ?? {})) url.searchParams.set(key, value)
  const init: RequestInit = { method: opts.method ?? 'GET', headers: { ...opts.headers } }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
    init.headers = { 'Content-Type': 'application/json', ...opts.headers }
  }
  return new Request(url, init)
}

export async function callRoute(
  route: APIRoute,
  ctx: PluginContext,
  opts: { path?: string; body?: unknown; searchParams?: Record<string, string>; headers?: Record<string, string>; rawResponse?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const req = makeRequest(opts.path ?? route.path, {
    method: route.method,
    body: opts.body,
    searchParams: opts.searchParams,
    headers: opts.headers,
  })
  // Third handler arg mirrors the host registry's parsed input: `:key`
  // segments of the declared path matched against the actual path.
  const params: Record<string, string> = {}
  const declared = route.path.split('/')
  const actual = (opts.path ?? route.path).split('?')[0]!.split('/')
  declared.forEach((seg, i) => {
    // A still-templated segment (test called with the declared path) is NOT a value.
    if (seg.startsWith(':') && actual[i] !== undefined && !actual[i]!.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual[i]!)
  })
  const response = await route.handler(req, ctx, {
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(opts.searchParams ? { query: opts.searchParams } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  })
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
