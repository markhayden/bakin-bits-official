/**
 * Temporary local SDK contract for official plugin development.
 *
 * Keep this file explicit: it mirrors the public `@makinbakin/sdk` symbols used by
 * official plugins until the SDK package is installable from npm/GitHub. Do
 * not add catch-all `any` module declarations for Bakin internals.
 */

declare module '@makinbakin/sdk/types' {
  import type { ComponentType } from 'react'
  import type { ZodRawShape } from 'zod'

  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  export type ContractVisibility = 'public' | 'internal' | 'experimental'
  export type ContractStability = 'stable' | 'beta' | 'experimental' | 'deprecated'

  export interface SchemaLike<T = unknown> {
    parse(data: unknown): T
    safeParse?(data: unknown): { success: true; data: T } | { success: false; error: unknown }
  }

  export interface DocsExample {
    title: string
    description?: string
    code?: string
    request?: unknown
    response?: unknown
    test?: 'automated' | 'schema' | 'illustrative'
    reason?: string
  }

  export interface SourceLocation {
    file: string
    symbol?: string
    line?: number
  }

  export type PluginPermission =
    | 'storage.read'
    | 'storage.write'
    | 'events.emit'
    | 'runtime.read'
    | 'runtime.agents'
    | 'runtime.messaging'
    | 'runtime.channels'
    | 'runtime.cron'
    | 'runtime.skills'
    | 'runtime.models'
    | 'tasks.read'
    | 'tasks.write'
    | 'search.read'
    | 'search.write'
    | 'assets.read'

  export type RuntimeCapability =
    | 'agents'
    | 'messaging'
    | 'channels.message'
    | 'channels.rich-content'
    | 'channels.interactive-approval'
    | 'channels.threaded-replies'
    | 'cron'
    | 'skills'
    | 'models'
    | 'tasks'
    | 'search'

  export interface PluginEntryPoints {
    server: string
    client?: string
  }

  export interface ApiRouteContribution {
    method: HttpMethod
    path: string
    summary: string
    description?: string
    operationId?: string
    tags?: string[]
    visibility?: 'public' | 'internal' | 'experimental'
    stability?: 'stable' | 'beta' | 'experimental' | 'deprecated'
    parameters?: ApiParameterContribution[]
    requestBody?: ApiRequestBodyContribution
    responses?: Record<string, ApiResponseContribution>
    permissions?: PluginPermission[]
  }

  export type JsonSchemaContribution = Record<string, unknown>

  export interface ApiParameterContribution {
    name: string
    in: 'path' | 'query' | 'header' | 'cookie'
    required?: boolean
    description?: string
    schema?: JsonSchemaContribution
    example?: unknown
  }

  export interface ApiRequestBodyContribution {
    description?: string
    required?: boolean
    contentType?: string
    schema?: JsonSchemaContribution
    example?: unknown
  }

  export interface ApiResponseContribution {
    description: string
    contentType?: string
    schema?: JsonSchemaContribution
    example?: unknown
  }

  export interface ClientRouteContribution {
    path: string
    summary: string
    slot?: string
  }

  export interface ExecToolContribution {
    name: string
    summary: string
    description?: string
    permissions?: PluginPermission[]
  }

  export interface CliCommandContribution {
    name: string
    usage: string
    summary: string
    description?: string
    aliases?: string[]
    dispatch: { type: 'apiRoute'; method: HttpMethod; path: string } | { type: 'execTool'; name: string }
  }

  export interface PluginContributions {
    apiRoutes?: ApiRouteContribution[]
    clientRoutes?: ClientRouteContribution[]
    execTools?: ExecToolContribution[]
    cliCommands?: CliCommandContribution[]
    settings?: Array<{ key: string; summary: string }>
    docs?: { slug: string }
  }

  export interface PluginManifest {
    id: string
    name: string
    version: string
    bakin: string
    description: string
    entry: PluginEntryPoints
    contentFiles?: string[]
    secrets?: string[]
    tests?: string
    dependencies?: string[]
    permissions?: PluginPermission[]
    runtimeCapabilities?: RuntimeCapability[]
    contributes?: PluginContributions
    devWatch?: string[]
  }

  export interface StorageStat {
    path: string
    size: number
    mtimeMs: number
    isFile: boolean
    isDirectory: boolean
  }

  export interface StorageAdapter {
    read(path: string): string | null
    write(path: string, content: string): void
    append(path: string, content: string): void
    exists(path: string): boolean
    readAll(): Record<string, string>
    list?(path?: string): string[]
    remove?(path: string): void
    rename?(from: string, to: string): void
    stat?(path: string): StorageStat | null
    readJson?<T = unknown>(path: string): T | null
    writeJson?(path: string, value: unknown): void
    searchPath?(path: string): string
  }

  export interface EventBus {
    emit(event: string, data?: Record<string, unknown>): void
    on(pattern: string, handler: (event: string, data: Record<string, unknown>) => void): () => void
    once(pattern: string, handler: (event: string, data: Record<string, unknown>) => void): () => void
  }

  export interface ActivityAPI {
    log(agent: string, message: string, opts?: { taskId?: string; category?: string }): void
    audit(event: string, agent: string, data?: Record<string, unknown>): void
  }

  export interface PluginLogger {
    debug(message: string, data?: Record<string, unknown>): void
    info(message: string, data?: Record<string, unknown>): void
    warn(message: string, errorOrData?: unknown, data?: Record<string, unknown>): void
    error(message: string, errorOrData?: unknown, data?: Record<string, unknown>): void
  }

  export type HookKind = 'rpc' | 'event' | 'waterfall'

  export interface HookRegistrationMetadata {
    label?: string
    summary: string
    description?: string
    hookKind?: HookKind
    input?: SchemaLike
    output?: SchemaLike
    visibility?: ContractVisibility
    stability?: ContractStability
    examples?: DocsExample[]
  }

  export interface HookAPI {
    register(name: string, handler: (data: unknown) => unknown, metadata?: HookRegistrationMetadata): () => void
    call<T>(name: string, data: T): Promise<T>
    callAll(name: string, data: Record<string, unknown>): Promise<void>
    has(name: string): boolean
    invoke<R>(name: string, data: unknown): Promise<R | undefined>
  }

  export interface NavItem {
    id: string
    label: string
    icon: string
    href: string
    order?: number
    children?: NavItem[]
    alwaysExpanded?: boolean
  }

  export interface APIRoute {
    path: string
    method: HttpMethod
    handler: (req: Request, ctx: PluginContext) => Response | Promise<Response>
    summary?: string
    description?: string
    params?: string
    input?: SchemaLike
    output?: SchemaLike
    visibility?: ContractVisibility
    stability?: ContractStability
    examples?: DocsExample[]
    source?: SourceLocation
    permissions?: string[]
  }

  export interface UISlotRegistration {
    slot: string
    component: ComponentType<Record<string, unknown>>
    order?: number
  }

  export interface ContentFile {
    path: string
  }

  export interface RuntimeAgent {
    id: string
    name: string
    role?: string
    model?: string
    status?: 'active' | 'inactive' | 'unknown'
    metadata?: Record<string, unknown>
  }

  export interface RuntimeChannel {
    id: string
    platform: string
    label: string
    capabilities: string[]
    metadata?: Record<string, unknown>
  }

  export interface RuntimeMessageArgs {
    agentId: string
    content: string
    threadId?: string
    metadata?: Record<string, unknown>
  }

  export interface RuntimeMessageResult {
    id: string
    content?: string
    metadata?: Record<string, unknown>
  }

  export interface RuntimeChatChunk {
    type: 'text' | 'tool' | 'status' | 'done' | 'error'
    content?: string
    data?: unknown
  }

  export interface CronJob {
    id: string
    name: string
    schedule: string
    command: string
    enabled: boolean
    metadata?: Record<string, unknown>
  }

  export interface CronRun {
    id: string
    jobId: string
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    startedAt?: string
    endedAt?: string
    output?: string
    error?: string
  }

  export interface RuntimeSkill {
    name: string
    description?: string
  }

  export interface AvailableModel {
    id: string
    name?: string
    provider?: string
    available?: boolean
    [key: string]: unknown
  }

  export interface AssetFileRef {
    kind: 'asset'
    filename: string
    mimeType?: string
  }

  export interface AgentRuntimeAdapter {
    agents: {
      list(): Promise<RuntimeAgent[]>
      get(agentId: string): Promise<RuntimeAgent | null>
    }
    messaging: {
      send(input: RuntimeMessageArgs): Promise<RuntimeMessageResult>
      stream(input: RuntimeMessageArgs): AsyncIterable<RuntimeChatChunk>
    }
    channels: {
      list(): Promise<RuntimeChannel[]>
      sendMessage(input: {
        channels: string[]
        message: { body: string; title?: string; threadId?: string; metadata?: Record<string, unknown> }
      }): Promise<{ deliveries: Array<{ channelId: string; ref: string; renderedAt: string }> }>
      deliverContent(input: {
        channels: string[]
        content: {
          title: string
          body?: string
          url?: string
          files?: AssetFileRef[]
          metadata?: Record<string, unknown>
        }
      }): Promise<{ deliveries: Array<{ channelId: string; ref: string; renderedAt: string }> }>
    }
    cron: {
      list(): Promise<CronJob[]>
      get(id: string): Promise<CronJob | null>
      create(input: { id?: string; name: string; schedule: string; command: string; enabled?: boolean; metadata?: Record<string, unknown> }): Promise<CronJob>
      update(id: string, patch: Partial<Omit<CronJob, 'id'>>): Promise<CronJob>
      remove(id: string): Promise<void>
      runNow(id: string): Promise<CronRun>
      listRuns(jobId: string): Promise<CronRun[]>
    }
    skills?: { list(): Promise<RuntimeSkill[]> }
    models?: { listAvailable(opts?: { includeUnavailable?: boolean }): Promise<AvailableModel[]> }
  }

  export type ColumnId = 'backlog' | 'inProgress' | 'todo' | 'review' | 'done' | 'blocked' | 'archived'

  export interface TaskLogEntry {
    timestamp: string
    author: string
    message: string
    data?: Record<string, unknown>
  }

  export interface TaskSource {
    pluginId: string
    entityType?: string
    entityId?: string
    purpose?: string
  }

  export interface Task {
    id: string
    title: string
    agent?: string
    createdBy?: string
    checked: boolean
    column: ColumnId
    date?: string
    blockedReason?: string
    description?: string
    availableAt?: string
    dueAt?: string
    source?: TaskSource
    log?: TaskLogEntry[]
    dependsOn?: string
    parentId?: string | null
    workflowId?: string
    skipWorkflowReason?: string
    scheduleJobId?: string
    projectId?: string
    order?: number
    createdAt?: string
    updatedAt?: string
  }

  export interface TaskCreateInput {
    id?: string
    title: string
    description?: string
    agent?: string
    createdBy?: string
    column?: ColumnId
    date?: string
    availableAt?: string
    dueAt?: string
    source?: TaskSource
    workflowId?: string
    projectId?: string
    parentId?: string | null
    skipWorkflowReason?: string
  }

  export interface TaskUpdateInput {
    title?: string
    description?: string
    agent?: string
    createdBy?: string
    checked?: boolean
    column?: ColumnId
    date?: string
    availableAt?: string
    dueAt?: string
    source?: TaskSource
    blockedReason?: string
    workflowId?: string
    scheduleJobId?: string
    projectId?: string
    parentId?: string | null
  }

  export interface TaskService {
    create(input: TaskCreateInput): Promise<Task>
    update(id: string, patch: TaskUpdateInput): Promise<Task>
    move(id: string, column: ColumnId): Promise<Task>
    remove(id: string): Promise<void>
    get(id: string): Promise<Task | null>
    list(filter?: { column?: ColumnId; agent?: string; projectId?: string }): Promise<Task[]>
    appendLog(id: string, entry: TaskLogEntry): Promise<void>
  }

  export interface SearchSchemaField {
    type: 'text' | 'keyword' | 'number' | 'boolean' | 'datetime' | 'array'
  }

  export interface SearchIndexDefinition {
    name: string
    embedderRef: string
    embeddingTemplate?: string
    mediaUrlField?: string
    chunker?: { enabled: boolean; targetTokens?: number; overlapTokens?: number }
  }

  export interface SearchContentTypeDefinition {
    table: string
    schema: Record<string, SearchSchemaField>
    searchableFields: string[]
    embeddingTemplate: string
    indexes?: SearchIndexDefinition[]
    facets?: string[]
    rerankField?: string
    ttl?: string
    ttlField?: string
    chunker?: { enabled: boolean; targetTokens?: number; overlapTokens?: number }
    reindex: () => AsyncGenerator<{ key: string; doc: Record<string, unknown> }>
    verifyExists: (key: string) => Promise<boolean>
  }

  export interface FilePatternMapper {
    pattern: string
    fileToId: (relPath: string) => string | null
    fileToDoc: (relPath: string, content: string) => Promise<Record<string, unknown> | null>
  }

  export interface FileBackedContentTypeDefinition extends SearchContentTypeDefinition {
    filePatterns: FilePatternMapper[]
    excludePatterns?: string[]
    onSync?: (relPath: string, content: string) => Promise<void>
    onUnlink?: (relPath: string) => Promise<void>
    buildOnStartup?: boolean
  }

  export interface SearchQueryParams {
    q: string
    filters?: Record<string, string | boolean | number>
    facets?: string[]
    limit?: number
    offset?: number
    rerank?: boolean
    aggregations?: Record<string, unknown>
    strategy?: 'rrf' | 'semantic_only' | 'full_text_only'
  }

  export interface SearchResult {
    id: string
    table: string
    score: number
    fields: Record<string, unknown>
    rerankScore?: number
    indexScores?: Record<string, number>
  }

  export interface SearchResponse {
    results: SearchResult[]
    aggregations?: Record<string, Array<{ value: string; count: number }>>
    rawAggregations?: Record<string, unknown>
    meta: { query: string; total: number; took_ms: number; source: 'search' | 'fallback' }
  }

  export interface SearchTransformOp {
    op: '$set' | '$inc' | '$push'
    field?: string
    value: unknown
  }

  export interface SearchAPI {
    registerContentType(def: SearchContentTypeDefinition): void
    registerFileBackedContentType(def: FileBackedContentTypeDefinition): void
    index(key: string, doc: Record<string, unknown>): Promise<void>
    remove(key: string): Promise<void>
    transform(key: string, operations: SearchTransformOp[]): Promise<void>
    query(params: SearchQueryParams): Promise<SearchResponse>
  }

  export interface AssetVariantMeta {
    role: 'thumbnail' | 'optimized' | 'webp'
    path: string
    filename: string
    size: number
    mimeType: string
  }

  export interface AssetMeta {
    path: string
    filename: string
    type: 'text' | 'images' | 'video' | 'audio' | 'plans' | 'research' | 'pdf' | 'data' | 'other'
    mimeType: string
    size: number
    mtimeMs?: number
    metadata: {
      agent: string
      taskId: string | null
      created: string
      tool?: string
      description?: string
      tags?: string[]
      originalFilename?: string
    }
    variants?: AssetVariantMeta[]
  }

  export interface AssetsAPI {
    getByFilename(filename: string): Promise<AssetMeta | null>
    list(filter?: { type?: AssetMeta['type']; taskId?: string | null }): Promise<AssetMeta[]>
    exists(filename: string): Promise<boolean>
    fileRef(filename: string): Promise<AssetFileRef>
  }

  export interface ExecToolResult {
    ok: boolean
    error?: string
    details?: unknown
    [key: string]: unknown
  }

  export interface PluginToolContext {
    storage: StorageAdapter
    events: EventBus
    pluginId: string
    runtime: AgentRuntimeAdapter
    tasks: TaskService
    search: SearchAPI
    assets: AssetsAPI
    hooks: HookAPI
    activity: ActivityAPI
    getSettings<T = Record<string, unknown>>(): T
  }

  export interface ExecToolDefinition {
    name: string
    description: string
    label?: string
    activityDuplicate?: boolean
    parameters: ZodRawShape
    handler: (params: Record<string, unknown>, agent: string, ctx?: PluginToolContext) => Promise<ExecToolResult>
    source?: string
  }

  export interface SkillDefinition {
    name: string
    instructions: string
    output_schema?: Record<string, unknown>
    source?: string
  }

  export interface WorkflowDefinitionInput {
    id?: string
    name: string
    description: string
    version: number
    inputs?: Record<string, unknown>
    steps: unknown[]
  }

  export interface PluginNodeTypeInput<T = unknown> {
    kind: string
    zodSchema: SchemaLike<T>
    formFields: Array<Record<string, unknown>>
    edgeRules?: { maxInbound?: number; maxOutbound?: number }
  }

  export interface PluginNotificationChannelInput {
    id: string
    label: string
    initials?: string
    icon?: string
  }

  export interface HealthCheckResult {
    check: string
    status: 'ok' | 'warn' | 'error' | 'fixed'
    message: string
    autoFixable: boolean
  }

  export interface PluginHealthCheckInput {
    id: string
    name: string
    run: () => Promise<HealthCheckResult[]>
    autoFix?: boolean
  }

  export type FormFieldType = 'string' | 'text' | 'number' | 'boolean' | 'select' | 'agent' | 'skill' | 'list'
  export interface PluginSettingsSchema {
    fields: Array<Record<string, unknown> & { type: FormFieldType; key: string; label: string }>
  }

  export interface PluginContext {
    storage: StorageAdapter
    events: EventBus
    pluginId: string
    runtime: AgentRuntimeAdapter
    tasks: TaskService
    assets: AssetsAPI
    registerNav(items: NavItem[]): void
    registerRoute(route: APIRoute): void
    registerSlot(registration: UISlotRegistration): void
    registerExecTool(tool: ExecToolDefinition): void
    registerSkill(skill: SkillDefinition): void
    registerWorkflow(definition: WorkflowDefinitionInput, opts?: { readOnly?: boolean }): void
    registerNodeType<T = unknown>(def: PluginNodeTypeInput<T>): string
    registerNotificationChannel(def: PluginNotificationChannelInput): string
    registerHealthCheck(def: PluginHealthCheckInput): string
    watchFiles(patterns: string[]): void
    getSettings<T = Record<string, unknown>>(): T
    updateSettings(patch: Record<string, unknown>): void
    activity: ActivityAPI
    log?: PluginLogger
    hooks: HookAPI
    search: SearchAPI
  }

  export interface BakinPlugin {
    id: string
    name: string
    version: string
    activate(ctx: PluginContext): void | Promise<void>
    onReady?(): void | Promise<void>
    onShutdown?(): void | Promise<void>
    onSettingsChange?(settings: Record<string, unknown>): void | Promise<void>
    onUninstall?(ctx: PluginContext): void | Promise<void>
    settingsSchema?: PluginSettingsSchema
    navItems?: NavItem[]
    contentFiles?: ContentFile[]
  }
}

declare module '@makinbakin/sdk' {
  export * from '@makinbakin/sdk/types'
  import type { ComponentType } from 'react'
  import type { NavItem } from '@makinbakin/sdk/types'

  export interface ClientRouteEntry {
    path: string
    component: ComponentType<Record<string, unknown>>
  }

  export interface PluginRegistration {
    id: string
    navItems?: NavItem[]
    routes?: Record<string, ComponentType<any>>
    slots?: Record<string, ComponentType<any>>
  }

  export function registerPlugin(def: PluginRegistration): void
  export function unregisterPlugin(id: string): void
  export function getAllNavItems(): NavItem[]
}

declare module '@makinbakin/sdk/ui' {
  import type { ComponentType, ReactNode } from 'react'
  interface UIProps {
    children?: ReactNode
    onClick?: (event: any) => void
    onChange?: (event: any) => void
    onKeyDown?: (event: any) => void
    onOpenChange?: (open: any) => void
    onValueChange?: (value: any) => void
    [key: string]: any
  }
  type UIComponent = ComponentType<UIProps>

  export const Alert: UIComponent
  export const Avatar: UIComponent
  export const Badge: UIComponent
  export const Button: UIComponent
  export const Card: UIComponent
  export const Checkbox: UIComponent
  export const Collapsible: UIComponent
  export const Command: UIComponent
  export const Dialog: UIComponent
  export const DialogContent: UIComponent
  export const DialogHeader: UIComponent
  export const DialogTitle: UIComponent
  export const DropdownMenu: UIComponent
  export const DropdownMenuTrigger: UIComponent
  export const DropdownMenuContent: UIComponent
  export const DropdownMenuItem: UIComponent
  export const DropdownMenuSeparator: UIComponent
  export const Form: UIComponent
  export const Input: UIComponent
  export const InputGroup: UIComponent
  export const Label: UIComponent
  export const Popover: UIComponent
  export const Progress: UIComponent
  export const Select: UIComponent
  export const SelectContent: UIComponent
  export const SelectItem: UIComponent
  export const SelectTrigger: UIComponent
  export const SelectValue: UIComponent
  export const Separator: UIComponent
  export const Sheet: UIComponent
  export const Skeleton: UIComponent
  export const Switch: UIComponent
  export const Table: UIComponent
  export const TableHeader: UIComponent
  export const TableBody: UIComponent
  export const TableRow: UIComponent
  export const TableHead: UIComponent
  export const TableCell: UIComponent
  export const Tabs: UIComponent
  export const Textarea: UIComponent
  export const Tooltip: UIComponent
}

declare module '@makinbakin/sdk/components' {
  import type { ComponentType, ReactNode } from 'react'
  interface SDKProps {
    children?: ReactNode
    onClick?: (event: any) => void
    onChange?: (value: any) => void
    onOpenChange?: (open: any) => void
    onValueChange?: (value: any) => void
    [key: string]: any
  }
  type SDKComponent = ComponentType<SDKProps>

  export interface AgentInfo {
    id: string
    name: string
    color?: string
    avatar?: string
  }

  export type SortDir = 'asc' | 'desc'

  export interface BrainstormMessage {
    id?: string
    agentId?: string
    role: 'user' | 'assistant' | 'system' | 'activity'
    content: string
    kind?: 'runtime_status' | 'tool_call' | 'error' | string
    data?: unknown
    createdAt?: string
    timestamp?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }

  export interface BrainstormActivityStorageInput {
    id?: string
    kind?: string
    content?: string
    data?: unknown
    timestamp?: string
  }

  export interface BrainstormActivityStorageRecord {
    kind: string
    content: string
    data?: unknown
  }

  export interface SendContext {
    signal: AbortSignal
    onToken: (text: string) => void
    onCustom?: (name: string, data: unknown) => void
  }

  export function readBrainstormSseResponse(
    response: Response,
    ctx: SendContext,
    options?: {
      onCustomEvent?: (event: string, data: unknown) => boolean | void
    },
  ): Promise<{ content: string }>
  export function brainstormThreadId(scope: string, entityId: string, agentId: string): string
  export function normalizeBrainstormActivityForStorage(activity: BrainstormActivityStorageInput): BrainstormActivityStorageRecord | null
  export function normalizeBrainstormActivityMessageForStorage(activity: BrainstormActivityStorageInput): Pick<BrainstormMessage, 'role' | 'kind' | 'content' | 'data'> | null

  export const AgentAvatar: ComponentType<{ agentId?: string; agent?: AgentInfo | null; size?: string | number; className?: string }>
  export const AgentFilter: SDKComponent
  export const AgentSelect: SDKComponent
  export const BakinDrawer: SDKComponent
  export const ChannelIcon: SDKComponent
  export const EmptyState: SDKComponent
  export const FacetFilter: SDKComponent
  export const IntegratedBrainstorm: SDKComponent
  export const MarkdownEditor: SDKComponent
  export const PluginHeader: ComponentType<{
    title: string
    subtitle?: string
    count?: number
    search?: Record<string, unknown>
    actions?: ReactNode
    meta?: ReactNode
    children?: ReactNode
  }>
  export const SortableHead: ComponentType<Record<string, unknown> & { children?: ReactNode }>
}

declare module '@makinbakin/sdk/hooks' {
  export interface AgentInfo {
    id: string
    name: string
    color?: string
    avatar?: string
  }

  export interface NotificationChannel {
    id: string
    label: string
    initials?: string
    icon?: string
  }

  export interface SearchResult {
    id: string
    table?: string
    score: number
    fields: Record<string, unknown>
    rerankScore?: number
    indexScores?: Record<string, number>
  }

  export interface UseSearchReturn {
    results: SearchResult[]
    loading: boolean
    error?: Error | null
    search(query: string): void
    clear(): void
  }

  export function useRouter(): {
    push(path: string, opts?: Record<string, unknown>): void
    replace(path: string, opts?: Record<string, unknown>): void
    back(): void
  }
  export function usePathname(): string
  export function useSearchParams(): URLSearchParams
  export function useQueryState(key: string, defaultValue: string): [string, (next: string, opts?: unknown) => void, (next: string, opts?: unknown) => void]
  export function useQueryArrayState(key: string): [string[], (next: string[]) => void]
  export function useSearch(opts?: Record<string, unknown>): UseSearchReturn
  export function useAgent(agentId: string): AgentInfo | null
  export function useAgentList(): AgentInfo[]
  export function useAgentIds(): string[]
  export function useMainAgentId(): string | null
  export function useDebug(): [boolean]
  export function useNotificationChannels(): NotificationChannel[]
  export function getChannelLabel(channelId: string, channels?: NotificationChannel[]): string
  export function toast(message: string, type?: 'success' | 'error' | 'info' | 'warning'): void
}

declare module '@makinbakin/sdk/slots' {
  import type { ComponentType, ReactElement } from 'react'
  export function Slot(props: { name: string; [key: string]: unknown }): ReactElement | null
  export function registerSlot<TProps>(name: string, component: ComponentType<TProps>, order?: number, owner?: string): void
}

declare module '@makinbakin/sdk/utils' {
  import type { RuntimeChatChunk } from '@makinbakin/sdk/types'

  export interface BrainstormActivityInput {
    kind: string
    content: string
    data?: unknown
  }

  export interface BrainstormActivityStorageInput {
    id?: string
    kind?: string
    content?: string
    data?: unknown
    timestamp?: string
  }

  export interface BrainstormActivityStorageRecord {
    kind: string
    content: string
    data?: unknown
  }

  export function cn(...args: Array<string | undefined | null | false>): string
  export function formatAge(date: Date | string): string
  export function formatSize(bytes: number): string
  export function brainstormThreadId(scope: string, entityId: string, agentId: string): string
  export function normalizeBrainstormActivityForStorage(activity: BrainstormActivityStorageInput): BrainstormActivityStorageRecord | null
  export function normalizeBrainstormActivityMessageForStorage(activity: BrainstormActivityStorageInput): {
    role: 'activity'
    kind: string
    content: string
    data?: unknown
  } | null
  export function runtimeChunkToBrainstormActivity(chunk: RuntimeChatChunk): BrainstormActivityInput | null
  export function readBrainstormSseResponse(
    response: Response,
    ctx: {
      signal: AbortSignal
      onToken: (text: string) => void
      onCustom?: (name: string, data: unknown) => void
    },
    options?: {
      onCustomEvent?: (event: string, data: unknown) => boolean | void
    },
  ): Promise<{ content: string }>
}
