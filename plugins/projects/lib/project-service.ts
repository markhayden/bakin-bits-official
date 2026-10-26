/**
 * Projects plugin service layer.
 *
 * All host-owned capabilities are injected through PluginContext so this file
 * can run as an extracted official plugin without Bakin core imports.
 */
import type { PluginContext } from '@makinbakin/sdk/types'
import {
  type ProjectRepository,
  computeProgress,
  nextTaskItemId,
} from './parser'
import type { ChecklistPromotionOperation, MutationCaller, Project, ProjectKickoff, ProjectTask, ProjectStatus, TitleSource } from '../types'
import { assertItemIdentity, assertExpectedFields, ProjectMutationError, validateItemPatch, validateProjectPatch } from './project-mutations'

const log = {
  info: (...args: unknown[]) => console.info('[projects]', ...args),
  warn: (...args: unknown[]) => console.warn('[projects]', ...args),
  error: (...args: unknown[]) => console.error('[projects]', ...args),
}

function generateProjectId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function getProjectLock(): { queue: Promise<void> } {
  const g = globalThis as Record<string, unknown>
  if (!g.__bakinProjectLock) g.__bakinProjectLock = { queue: Promise.resolve() }
  return g.__bakinProjectLock as { queue: Promise<void> }
}

function withProjectLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lock = getProjectLock()
  const next = lock.queue.then(fn, fn) as Promise<T>
  lock.queue = next.then(() => {}, () => {})
  return next
}

export interface TaskLinkEntry {
  projectId: string
  taskItemId: string
}

function getIndex(): Map<string, TaskLinkEntry> {
  const g = globalThis as Record<string, unknown>
  if (!g.__bakinProjectIndex) g.__bakinProjectIndex = new Map<string, TaskLinkEntry>()
  return g.__bakinProjectIndex as Map<string, TaskLinkEntry>
}

export interface CreateProjectOpts {
  title: string
  titleSource: TitleSource
  body?: string
  owner?: string
  tasks?: string[]
}

/** The start screen's first send (D8). */
export interface KickoffProjectOpts {
  requestId: string
  title: string
  owner: string
  message: string
}

export interface UpdateProjectOpts {
  title?: string
  status?: ProjectStatus
  body?: string
  owner?: string
}

/** Agent plan writes: never lifecycle status (D9a). */
export interface ApplyProjectPlanOpts extends Omit<UpdateProjectOpts, 'status'> {
  appendBody?: string
  checklistItems?: string[]
}

export interface ApplyProjectPlanResult {
  addedItems: { id: string; title: string }[]
  progress: number
  updated: {
    title: boolean
    body: boolean
    owner: boolean
    checklistItems: boolean
  }
}

export interface PromoteItemOpts {
  expectedInstanceId?: string
  requestId?: string
  assignee?: string
  workflowId?: string
  skipWorkflowReason?: string
}

export interface ResolvedAsset {
  assetId: string
  label?: string
  type: string
  description?: string
  tags?: string[]
  missing?: boolean
}

/** Board columns that complete a linked step (D16a). */
const DONE_COLUMNS = new Set(['done', 'archived'])

/** Linked board tasks by id: the evidence `deriveChecklist` reads. */
export type BoardTaskIndex = ReadonlyMap<string, { column: string; title: string }>

/**
 * THE single source of `checked` and `progress` for every projection (D16a):
 * a linked step is checked exactly while its board task sits in a done
 * column (reopened ⇒ unchecked, missing ⇒ unchecked); only standalone steps
 * keep their stored flag.
 */
export function deriveChecklist<P extends Project>(project: P, board: BoardTaskIndex): P {
  const tasks = project.tasks.map(item => item.taskId
    ? { ...item, checked: DONE_COLUMNS.has(board.get(item.taskId)?.column ?? '') }
    : item)
  return { ...project, tasks, progress: computeProgress(tasks) }
}

export interface ProjectService {
  /** One board read for any number of projections. */
  boardIndex(): Promise<BoardTaskIndex>
  /** A project with its checklist derived from the live board. */
  derive<P extends Project>(project: P): Promise<P>
  rebuildIndex(): void
  getProjectForTask(boardTaskId: string): TaskLinkEntry | undefined
  getProjectTitleForTask(boardTaskId: string): string | null
  createProject(opts: CreateProjectOpts): Promise<{ id: string; taskItems: { id: string; title: string }[] }>
  /** Idempotent create keyed by `requestId`: a retry returns the same project. */
  kickoffProject(opts: KickoffProjectOpts): Promise<{ id: string; created: boolean; kickoff: ProjectKickoff }>
  /** Compare-and-set the kickoff state; false when the receipt moved on. */
  advanceKickoff(id: string, requestId: string, from: ProjectKickoff['state'], to: ProjectKickoff['state']): Promise<boolean>
  updateProject(id: string, updates: UpdateProjectOpts, caller: MutationCaller, expected?: UpdateProjectOpts): Promise<void>
  applyProjectPlan(id: string, updates: ApplyProjectPlanOpts, caller: MutationCaller): Promise<ApplyProjectPlanResult>
  /** Restore a plan snapshot by history index; snapshots the current body first (bakin#703). */
  restorePlanVersion(id: string, index: number, expectedTs?: string): Promise<{ changed: boolean }>
  deleteProject(id: string, agent?: string): Promise<void>
  addChecklistItem(projectId: string, title: string, requestId?: string): Promise<{ taskItemId: string; deleted?: boolean }>
  markChecklistItem(projectId: string, taskItemId: string, checked: boolean, expectedInstanceId?: string): Promise<{ progress: number }>
  updateChecklistItem(projectId: string, taskItemId: string, updates: { title?: string; description?: string }, expected?: { title?: string; description?: string }, expectedInstanceId?: string): Promise<void>
  removeChecklistItem(projectId: string, taskItemId: string, expectedInstanceId?: string): Promise<void>
  linkChecklistItem(projectId: string, taskItemId: string, boardTaskId: string): Promise<void>
  attachAsset(projectId: string, assetId: string, label?: string): Promise<void>
  relinkAsset(projectId: string, oldAssetId: string, newAssetId: string, label?: string): Promise<void>
  detachAsset(projectId: string, assetId: string): Promise<void>
  updateAssetLabel(projectId: string, assetId: string, label: string): Promise<void>
  promoteItemToTask(projectId: string, taskItemId: string, opts?: PromoteItemOpts): Promise<{ taskId: string }>
  autoUnlinkTask(boardTaskId: string): Promise<void>
  resolveLinkedTaskStatuses(project: Project): Promise<Project & {
    resolvedTasks: Record<string, { column: string; title: string } | null>
    resolvedAssets: ResolvedAsset[]
  }>
}

/**
 * The ONE authority chokepoint (D9a): every project-field write passes here
 * with its caller. Agents never change lifecycle status (that is the user's,
 * or an approval's) and never overwrite a title a human typed.
 */
function assertCallerMay(project: Project, patch: { title?: string; status?: ProjectStatus }, caller: MutationCaller): void {
  if (caller.kind !== 'agent') return
  if (patch.status !== undefined && patch.status !== project.status) {
    throw new ProjectMutationError('Agents cannot change a project\'s status — starting, completing and archiving are the user\'s decisions.', 403, 'agent_status')
  }
  if (patch.title !== undefined && patch.title !== project.title && project.titleSource === 'user') {
    throw new ProjectMutationError('The user named this project — keep their title.', 409, 'title_locked')
  }
}

/**
 * The ONE committed-body write (D15): snapshots the prior body with the
 * revision it was, then bumps the revision. No-op writes change nothing. A
 * user's own edit is seen by definition, so it advances the seen baseline.
 */
function commitBody(repo: ProjectRepository, project: Project, body: string, author: 'agent' | 'user'): boolean {
  if (body === project.body) return false
  const now = new Date().toISOString()
  repo.appendPlanSnapshot(project.id, { ts: now, author, body: project.body, revision: project.planRevision })
  project.body = body
  project.planRevision += 1
  project.planUpdatedBy = author
  project.planUpdatedAt = now
  if (author === 'user') repo.updateSeen(project.id, { planSeenRevision: project.planRevision })
  return true
}

function callerName(caller: MutationCaller, project: Project): string {
  return caller.kind === 'agent' ? caller.agentId : project.owner
}

// Reservations have globally unique IDs; simultaneous callers share only their own operation.
const promotionsInFlight = new Map<string, Promise<{ taskId: string }>>()

export function createProjectService(ctx: PluginContext, repo: ProjectRepository): ProjectService {
  function broadcast(data: Record<string, unknown>): void {
    const { type, ...payload } = data
    ctx.events.emit('projects.changed', { ...payload, projectId: payload.projectId ?? payload.id, action: type })
  }

  async function boardIndex(): Promise<BoardTaskIndex> {
    const tasks = await ctx.tasks.list()
    return new Map(tasks.map(task => [task.id, { column: String(task.column).toLowerCase(), title: task.title }]))
  }

  async function derive<P extends Project>(project: P): Promise<P> {
    return deriveChecklist(project, await boardIndex())
  }

  function rebuildIndex(): void {
    const index = getIndex()
    index.clear()
    for (const project of repo.readAllProjects()) {
      for (const item of project.tasks) {
        if (item.taskId) index.set(item.taskId, { projectId: project.id, taskItemId: item.id })
      }
    }
    log.info('Project index rebuilt', { entries: index.size })
  }

  function getProjectForTask(boardTaskId: string): TaskLinkEntry | undefined {
    return getIndex().get(boardTaskId)
  }

  function getProjectTitleForTask(boardTaskId: string): string | null {
    const entry = getIndex().get(boardTaskId)
    if (!entry) return null
    return repo.readProject(entry.projectId)?.title ?? null
  }

  async function createProject(opts: CreateProjectOpts): Promise<{ id: string; taskItems: { id: string; title: string }[] }> {
    return withProjectLock(() => {
      const id = generateProjectId()
      const now = new Date().toISOString()
      const taskItems: ProjectTask[] = (opts.tasks || []).map((title, i) => ({
        id: `t${String(i + 1).padStart(3, '0')}`,
        title,
        instanceId: crypto.randomUUID(),
        checked: false,
      }))

      const project: Project = {
        id,
        title: opts.title,
        titleSource: opts.titleSource,
        status: 'draft',
        created: now,
        updated: now,
        planRevision: 0,
        owner: opts.owner || 'main',
        tasks: taskItems,
        assets: [],
        body: opts.body ?? '',
        progress: 0,
      }

      repo.writeProject(project)
      ctx.activity.audit('created', project.owner, { id, title: project.title })
      broadcast({ type: 'project.created', id, title: project.title })
      return { id, taskItems: taskItems.map(t => ({ id: t.id, title: t.title })) }
    })
  }

  async function kickoffProject(opts: KickoffProjectOpts): Promise<{ id: string; created: boolean; kickoff: ProjectKickoff }> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(opts.requestId)) {
      throw new ProjectMutationError('Invalid create request identity.', 400, 'invalid_request_id')
    }
    const title = opts.title.trim()
    const message = opts.message.trim()
    if (!title || !message) throw new ProjectMutationError('A first message is required.', 400, 'invalid_request')
    return withProjectLock(() => {
      const existing = repo.readAllProjects().find(project => project.kickoff?.requestId === opts.requestId)
      if (existing) return { id: existing.id, created: false, kickoff: existing.kickoff! }
      const id = generateProjectId()
      const now = new Date().toISOString()
      const kickoff: ProjectKickoff = { requestId: opts.requestId, state: 'pending', message, agentId: opts.owner }
      repo.writeProject({
        id, title, titleSource: 'fallback', status: 'draft', created: now, updated: now,
        owner: opts.owner, tasks: [], assets: [], body: '', progress: 0, kickoff, planRevision: 0,
      })
      ctx.activity.audit('created', opts.owner, { id, title })
      broadcast({ type: 'project.created', id, title })
      return { id, created: true, kickoff }
    })
  }

  async function advanceKickoff(id: string, requestId: string, from: ProjectKickoff['state'], to: ProjectKickoff['state']): Promise<boolean> {
    return withProjectLock(() => {
      const project = repo.readProject(id)
      const kickoff = project?.kickoff
      if (!project || !kickoff || kickoff.requestId !== requestId || kickoff.state !== from) return false
      // Settled receipts keep only the dedupe identity.
      project.kickoff = to === 'settled' ? { requestId, state: to } : { ...kickoff, state: to }
      repo.writeProject(project)
      return true
    })
  }

  async function updateProject(id: string, updates: UpdateProjectOpts, caller: MutationCaller, expected?: UpdateProjectOpts): Promise<void> {
    const patch = validateProjectPatch(updates)
    return withProjectLock(() => {
      const project = repo.readProject(id)
      if (!project) throw new ProjectMutationError(`Project not found: ${id}`, 404, 'not_found')
      assertExpectedFields(project, patch, expected)
      if (Object.entries(patch).every(([field, value]) => value === undefined || project[field as keyof UpdateProjectOpts] === value)) return
      assertCallerMay(project, patch, caller)
      if (patch.title !== undefined && patch.title !== project.title) {
        project.title = patch.title
        project.titleSource = caller.kind
      }
      if (patch.status !== undefined) project.status = patch.status
      if (patch.body !== undefined) commitBody(repo, project, patch.body, caller.kind)
      if (patch.owner !== undefined) project.owner = patch.owner
      project.updated = new Date().toISOString()
      project.progress = computeProgress(project.tasks)
      repo.writeProject(project)
      ctx.activity.audit('updated', callerName(caller, project), { id, ...updates })
      broadcast({ type: 'project.updated', id, title: project.title })
    })
  }

  async function applyProjectPlan(id: string, updates: ApplyProjectPlanOpts, caller: MutationCaller): Promise<ApplyProjectPlanResult> {
    const { result, project } = await withProjectLock(() => {
      if (updates.body !== undefined && updates.appendBody !== undefined) {
        throw new Error('Provide either body or appendBody, not both')
      }

      const project = repo.readProject(id)
      if (!project) throw new Error(`Project not found: ${id}`)
      // Guard first: a refused title must not half-apply the checklist.
      assertCallerMay(project, { title: updates.title }, caller)

      const checklistItems = (updates.checklistItems ?? [])
        .map((title) => title.trim())
        .filter(Boolean)


      const addedItems: { id: string; title: string }[] = []
      for (const title of checklistItems) {
        const itemId = nextTaskItemId(project.tasks)
        project.tasks.push({ id: itemId, title, instanceId: crypto.randomUUID(), checked: false })
        addedItems.push({ id: itemId, title })
      }

      if (updates.title !== undefined && updates.title !== project.title) {
        project.title = updates.title
        project.titleSource = caller.kind
      }
      if (updates.owner !== undefined) project.owner = updates.owner
      // Every plan edit is snapshotted (visible diff + restore) and bumps the revision.
      if (updates.body !== undefined) {
        commitBody(repo, project, updates.body, caller.kind)
      } else if (updates.appendBody !== undefined) {
        commitBody(repo, project, [project.body.trimEnd(), updates.appendBody.trim()].filter(Boolean).join('\n\n'), caller.kind)
      }

      project.updated = new Date().toISOString()
      project.progress = computeProgress(project.tasks)
      repo.writeProject(project)

      ctx.activity.audit('plan.applied', callerName(caller, project), {
        id,
        addedItemCount: addedItems.length,
        title: updates.title,
        owner: updates.owner,
        bodyUpdated: updates.body !== undefined || updates.appendBody !== undefined,
      })
      broadcast({ type: 'project.updated', id, title: project.title })
      for (const item of addedItems) {
        broadcast({ type: 'project.checklist_changed', projectId: id, action: 'add', taskItemId: item.id })
      }

      const result: Omit<ApplyProjectPlanResult, 'progress'> = {
        addedItems,
        updated: {
          title: updates.title !== undefined,
          body: updates.body !== undefined || updates.appendBody !== undefined,
          owner: updates.owner !== undefined,
          checklistItems: addedItems.length > 0,
        },
      }
      return { result, project }
    })
    // Progress is derived from the live board, read outside the lock.
    return { ...result, progress: (await derive(project)).progress }
  }

  async function deleteProject(id: string, agent?: string): Promise<void> {
    return withProjectLock(() => {
      const project = repo.readProject(id)
      if (!project) throw new Error(`Project not found: ${id}`)
      repo.deleteProjectFile(id)
      const index = getIndex()
      for (const [taskId, entry] of index) {
        if (entry.projectId === id) index.delete(taskId)
      }
      ctx.activity.audit('deleted', agent || 'system', { id, title: project.title })
      broadcast({ type: 'project.deleted', id })
    })
  }

  async function addChecklistItem(projectId: string, title: string, requestId?: string): Promise<{ taskItemId: string; deleted?: boolean }> {
    const normalized = validateItemPatch({ title }).title!
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))) {
      throw new ProjectMutationError('Invalid checklist request identity.', 400, 'invalid_request_id')
    }
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new ProjectMutationError(`Project not found: ${projectId}`, 404, 'not_found')
      const receipt = project.operations?.find(operation => operation.requestId === requestId)
      if (receipt) {
        if (receipt.kind !== 'add-checklist' || receipt.title !== normalized) {
          throw new ProjectMutationError('This request was already used for a different checklist action.', 409, 'request_conflict')
        }
        const exists = project.tasks.some(item => item.instanceId === receipt.instanceId)
        return { taskItemId: receipt.taskItemId, ...(exists ? {} : { deleted: true }) }
      }
      const itemId = nextTaskItemId(project.tasks)
      const instanceId = crypto.randomUUID()
      project.tasks.push({ id: itemId, title: normalized, instanceId, checked: false })
      if (requestId) (project.operations ??= []).push({ kind: 'add-checklist', requestId, title: normalized, taskItemId: itemId, instanceId, phase: 'complete' })
      project.updated = new Date().toISOString()
      project.progress = computeProgress(project.tasks)
      // The host atomically replaces this one file: receipt and result travel together.
      repo.writeProject(project)
      ctx.activity.audit('checklist.added', 'system', { projectId, taskItemId: itemId })
      broadcast({ type: 'project.checklist_changed', projectId, action: 'add', taskItemId: itemId })
      return { taskItemId: itemId }
    })
  }

  async function markChecklistItem(projectId: string, taskItemId: string, checked: boolean, expectedInstanceId?: string): Promise<{ progress: number }> {
    const project = await withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new ProjectMutationError(`Project not found: ${projectId}`, 404, 'not_found')
      const item = project.tasks.find(t => t.id === taskItemId)
      if (!item) throw new ProjectMutationError(`Checklist item not found: ${taskItemId}`, 404, 'not_found')
      assertItemIdentity(item, expectedInstanceId)
      if (item.taskId) {
        throw new ProjectMutationError('This step completes from its board task — move the task instead.', 409, 'linked_step')
      }
      item.checked = checked
      project.updated = new Date().toISOString()
      project.progress = computeProgress(project.tasks)
      repo.writeProject(project)
      broadcast({ type: 'project.checklist_changed', projectId, action: 'mark', taskItemId, checked })
      return project
    })
    // Read the board outside the lock: task APIs can re-enter Projects.
    return { progress: (await derive(project)).progress }
  }

  async function updateChecklistItem(projectId: string, taskItemId: string, updates: { title?: string; description?: string }, expected?: { title?: string; description?: string }, expectedInstanceId?: string): Promise<void> {
    const patch = validateItemPatch(updates)
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new ProjectMutationError(`Project not found: ${projectId}`, 404, 'not_found')
      const item = project.tasks.find(t => t.id === taskItemId)
      if (!item) throw new ProjectMutationError(`Checklist item not found: ${taskItemId}`, 404, 'not_found')
      assertItemIdentity(item, expectedInstanceId)
      assertExpectedFields(item, patch, expected)
      if (Object.entries(patch).every(([field, value]) => value === undefined || (item[field as 'title' | 'description'] ?? '') === value)) return
      if (patch.title !== undefined) item.title = patch.title
      if (patch.description !== undefined) item.description = patch.description || undefined
      project.updated = new Date().toISOString()
      repo.writeProject(project)
      broadcast({ type: 'project.checklist_changed', projectId, action: 'update', taskItemId })
    })
  }

  async function removeChecklistItem(projectId: string, taskItemId: string, expectedInstanceId?: string): Promise<void> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const idx = project.tasks.findIndex(t => t.id === taskItemId)
      if (idx === -1) throw new Error(`Checklist item not found: ${taskItemId}`)
      const removed = project.tasks[idx]
      assertItemIdentity(removed, expectedInstanceId)
      if (removed.taskId) getIndex().delete(removed.taskId)
      project.tasks.splice(idx, 1)
      project.updated = new Date().toISOString()
      project.progress = computeProgress(project.tasks)
      repo.writeProject(project)
      broadcast({ type: 'project.checklist_changed', projectId, action: 'remove', taskItemId })
    })
  }

  async function linkChecklistItem(projectId: string, taskItemId: string, boardTaskId: string): Promise<void> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const item = project.tasks.find(t => t.id === taskItemId)
      if (!item) throw new Error(`Checklist item not found: ${taskItemId}`)
      if (item.taskId) getIndex().delete(item.taskId)
      item.taskId = boardTaskId
      project.updated = new Date().toISOString()
      repo.writeProject(project)
      getIndex().set(boardTaskId, { projectId, taskItemId })
      broadcast({ type: 'project.checklist_changed', projectId, action: 'link', taskItemId, boardTaskId })
    })
  }

  async function attachAsset(projectId: string, assetId: string, label?: string): Promise<void> {
    return withProjectLock(async () => {
      const project = repo.readProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const asset = await ctx.assets.getAsset(assetId)
      if (!asset) throw new Error(`Asset not found: ${assetId}`)
      if (project.assets.some(a => a.assetId === assetId)) return
      project.assets.push({ assetId, label })
      project.updated = new Date().toISOString()
      repo.writeProject(project)
      broadcast({ type: 'project.asset_changed', projectId, action: 'attach', assetId })
    })
  }

  async function detachAsset(projectId: string, assetId: string): Promise<void> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const idx = project.assets.findIndex(a => a.assetId === assetId)
      if (idx === -1) return
      project.assets.splice(idx, 1)
      project.updated = new Date().toISOString()
      repo.writeProject(project)
      broadcast({ type: 'project.asset_changed', projectId, action: 'detach', assetId })
    })
  }

  async function relinkAsset(projectId: string, oldAssetId: string, newAssetId: string, label?: string): Promise<void> {
    return withProjectLock(async () => {
      const project = repo.readProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const idx = project.assets.findIndex(a => a.assetId === oldAssetId)
      if (idx === -1) throw new Error(`Asset not attached: ${oldAssetId}`)
      const asset = await ctx.assets.getAsset(newAssetId)
      if (!asset) throw new Error(`Asset not found: ${newAssetId}`)

      const existingIdx = project.assets.findIndex(a => a.assetId === newAssetId)
      if (existingIdx !== -1 && existingIdx !== idx) {
        project.assets.splice(idx, 1)
      } else {
        project.assets[idx] = {
          assetId: newAssetId,
          label: label ?? project.assets[idx].label,
        }
      }

      project.updated = new Date().toISOString()
      repo.writeProject(project)
      broadcast({ type: 'project.asset_changed', projectId, action: 'relink', assetId: newAssetId })
    })
  }

  async function updateAssetLabel(projectId: string, assetId: string, label: string): Promise<void> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const asset = project.assets.find(a => a.assetId === assetId)
      if (!asset) throw new Error(`Asset not attached: ${assetId}`)
      asset.label = label || undefined
      project.updated = new Date().toISOString()
      repo.writeProject(project)
    })
  }

  async function promoteItemToTask(projectId: string, taskItemId: string, opts: PromoteItemOpts = {}): Promise<{ taskId: string }> {
    if (Object.values(opts).some(value => value !== undefined && typeof value !== 'string')
      || (opts.requestId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(opts.requestId))) {
      throw new ProjectMutationError('Invalid promotion options.', 400, 'invalid_request')
    }
    const reservation = await withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project) throw new ProjectMutationError(`Project not found: ${projectId}`, 404, 'not_found')
      const item = project.tasks.find(t => t.id === taskItemId)
      if (!item) throw new ProjectMutationError(`Checklist item not found: ${taskItemId}`, 404, 'not_found')
      const keyed = opts.requestId ? project.operations?.find(operation => operation.requestId === opts.requestId) : undefined
      const prior = keyed ?? project.operations?.find(operation => operation.kind === 'promote-checklist' && operation.instanceId === item.instanceId)
      if (prior) {
        if (prior.kind !== 'promote-checklist' || prior.instanceId !== item.instanceId || prior.taskItemId !== taskItemId
          || prior.assignee !== opts.assignee || prior.workflowId !== opts.workflowId || prior.skipWorkflowReason !== opts.skipWorkflowReason) {
          throw new ProjectMutationError('This promotion no longer matches the checklist item or requested options.', 409, 'promotion_conflict')
        }
        return prior
      }
      assertItemIdentity(item, opts.expectedInstanceId)
      if (item.taskId) throw new ProjectMutationError(`Item already linked to board task: ${item.taskId}`, 409, 'already_linked')
      item.instanceId ??= crypto.randomUUID()
      const operation: ChecklistPromotionOperation = {
        kind: 'promote-checklist', requestId: opts.requestId ?? crypto.randomUUID(),
        instanceId: item.instanceId, taskItemId, taskId: `task-${crypto.randomUUID()}`,
        title: item.title, assignee: opts.assignee, workflowId: opts.workflowId,
        skipWorkflowReason: opts.skipWorkflowReason, phase: 'reserved',
      }
      ;(project.operations ??= []).push(operation)
      repo.writeProject(project)
      return operation
    })
    const running = promotionsInFlight.get(reservation.taskId)
    if (running) return running
    const operation = finishPromotion(projectId, reservation)
    promotionsInFlight.set(reservation.taskId, operation)
    try { return await operation } finally { promotionsInFlight.delete(reservation.taskId) }
  }

  async function finishPromotion(projectId: string, reservation: ChecklistPromotionOperation): Promise<{ taskId: string }> {
    const source = { pluginId: 'projects', entityType: 'checklist', entityId: `${projectId}:${reservation.instanceId}`, purpose: reservation.requestId }
    // Never hold the project lock over task APIs: their hooks can call Projects.
    let task = await ctx.tasks.get(reservation.taskId)
    if (!task && reservation.phase === 'complete') {
      throw new ProjectMutationError('The promoted task was deleted. Refresh the project to review it.', 409, 'promoted_task_missing')
    }
    if (!task) {
      // A throw may follow a successful durable create. Leave the reservation and
      // report the failure; a retry reads this exact ID instead of blindly creating.
      task = await ctx.tasks.create({
        id: reservation.taskId, title: reservation.title, source, projectId,
        agent: reservation.assignee, description: 'Project task',
        workflowId: reservation.workflowId, skipWorkflowReason: reservation.skipWorkflowReason,
      })
    }
    if (task.id !== reservation.taskId || task.projectId !== projectId
      || Object.entries(source).some(([key, value]) => task!.source?.[key as keyof typeof source] !== value)) {
      throw new ProjectMutationError('The reserved board task belongs to a different operation. Review the project before retrying.', 409, 'promotion_conflict')
    }
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      const item = project?.tasks.find(t => t.id === reservation.taskItemId && t.instanceId === reservation.instanceId)
      const receipt = project?.operations?.find(operation => operation.kind === 'promote-checklist' && operation.taskId === reservation.taskId)
      if (!project || !item || !receipt || (item.taskId && item.taskId !== reservation.taskId)) {
        throw new ProjectMutationError(`Board task ${reservation.taskId} exists, but the checklist item changed or was removed. Refresh to review.`, 409, 'promotion_conflict')
      }
      if (receipt.phase === 'complete' && !item.taskId) {
        throw new ProjectMutationError('This completed promotion was unlinked. Refresh to review it.', 409, 'promotion_conflict')
      }
      if (receipt.phase !== 'complete') {
        item.taskId = reservation.taskId
        receipt.phase = 'complete'
        project.updated = new Date().toISOString()
        repo.writeProject(project)
        ctx.activity.audit('checklist.promoted', 'system', { projectId, taskItemId: item.id, taskId: reservation.taskId })
        broadcast({ type: 'project.checklist_changed', projectId, action: 'link', taskItemId: item.id, boardTaskId: reservation.taskId })
      }
      getIndex().set(reservation.taskId, { projectId, taskItemId: item.id })
      return { taskId: reservation.taskId }
    })
  }

  async function autoUnlinkTask(boardTaskId: string): Promise<void> {
    const entry = getIndex().get(boardTaskId)
    if (!entry) return
    log.info('Auto-unlinking deleted task', { boardTaskId, ...entry })
    await withProjectLock(() => {
      const project = repo.readProject(entry.projectId)
      if (!project) return
      const item = project.tasks.find(t => t.id === entry.taskItemId)
      if (!item || item.taskId !== boardTaskId) return
      item.taskId = undefined
      item.checked = false
      project.updated = new Date().toISOString()
      project.progress = computeProgress(project.tasks)
      repo.writeProject(project)
      getIndex().delete(boardTaskId)
      broadcast({ type: 'project.checklist_changed', projectId: entry.projectId, action: 'unlink', taskItemId: entry.taskItemId })
    })
  }

  async function resolveLinkedTaskStatuses(project: Project): Promise<Project & {
    resolvedTasks: Record<string, { column: string; title: string } | null>
    resolvedAssets: ResolvedAsset[]
  }> {
    const board = await boardIndex()
    const resolved: Record<string, { column: string; title: string } | null> = {}
    for (const item of project.tasks) {
      if (item.taskId) resolved[item.taskId] = board.get(item.taskId) ?? null
    }

    const resolvedAssets = await Promise.all(project.assets.map(async (asset) => {
      try {
        const indexed = typeof ctx.assets.getAsset === 'function'
          ? await ctx.assets.getAsset(asset.assetId)
          : null
        if (!indexed) return { assetId: asset.assetId, label: asset.label, type: 'unknown', missing: true }
        return {
          assetId: asset.assetId,
          label: asset.label,
          type: indexed.type,
          description: indexed.description,
          tags: indexed.tags,
        }
      } catch (err) {
        log.warn('Unable to resolve project asset', { projectId: project.id, assetId: asset.assetId, err })
        return { assetId: asset.assetId, label: asset.label, type: 'unknown', missing: true }
      }
    }))

    return { ...deriveChecklist(project, board), resolvedTasks: resolved, resolvedAssets }
  }

  /**
   * Restore a plan-history snapshot (bakin#703). The current body is
   * snapshotted first, so restore itself is never destructive.
   */
  async function restorePlanVersion(id: string, index: number, expectedTs?: string): Promise<{ changed: boolean }> {
    return withProjectLock(() => {
      const project = repo.readProject(id)
      if (!project) throw new Error(`Project not found: ${id}`)
      const history = repo.readPlanHistory(id)
      const snapshot = history[index]
      if (!snapshot) throw new Error(`No plan snapshot at index ${index}`)
      // Indexes shift when the cap trims or a concurrent edit appends — the
      // client pins the snapshot it showed the user; a mismatch means the
      // list went stale and a blind restore would apply the WRONG version.
      if (expectedTs !== undefined && snapshot.ts !== expectedTs) {
        throw new Error('History changed since the list was loaded — refresh and retry')
      }
      if (!commitBody(repo, project, snapshot.body, 'user')) return { changed: false }
      project.updated = new Date().toISOString()
      repo.writeProject(project)
      ctx.activity.audit('plan.restored', project.owner, { id, snapshotTs: snapshot.ts })
      broadcast({ type: 'project.updated', id, title: project.title })
      return { changed: true }
    })
  }

  return {
    boardIndex,
    derive,
    rebuildIndex,
    restorePlanVersion,
    kickoffProject,
    advanceKickoff,
    getProjectForTask,
    getProjectTitleForTask,
    createProject,
    updateProject,
    applyProjectPlan,
    deleteProject,
    addChecklistItem,
    markChecklistItem,
    updateChecklistItem,
    removeChecklistItem,
    linkChecklistItem,
    attachAsset,
    relinkAsset,
    detachAsset,
    updateAssetLabel,
    promoteItemToTask,
    autoUnlinkTask,
    resolveLinkedTaskStatuses,
  }
}
