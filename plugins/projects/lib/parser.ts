/**
 * Projects plugin — parser.
 * Parses project markdown files with YAML frontmatter and creates a
 * storage-backed repository for project file I/O.
 * Pure functions where possible — no side effects.
 */
import type { StorageAdapter } from '@makinbakin/sdk/types'
import { dump, load } from 'js-yaml'
import { parseBakinQuestion } from '@makinbakin/sdk/utils'
import { z } from 'zod'
import { TITLE_SOURCES, type PlanSnapshot, type Project, type ProjectFrontmatter, type ProjectTask, type ProjectAsset, type ProjectBrainstormMessage, type ProjectSeen, type ProjectSummary, type TitleSource } from '../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeProgress(tasks: ProjectTask[]): number {
  if (tasks.length === 0) return 0
  const checked = tasks.filter(t => t.checked).length
  return Math.round((checked / tasks.length) * 100)
}

export function nextTaskItemId(tasks: ProjectTask[]): string {
  let max = 0
  for (const t of tasks) {
    const num = parseInt(t.id.replace('t', ''), 10)
    if (!isNaN(num) && num > max) max = num
  }
  return `t${String(max + 1).padStart(3, '0')}`
}

function parseAsset(value: unknown): ProjectAsset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const assetId = typeof raw.assetId === 'string' && raw.assetId.trim()
    ? raw.assetId.trim()
    : typeof raw.filename === 'string' && raw.filename.trim()
      ? raw.filename.trim()
      : ''
  if (!assetId) return null
  return {
    assetId,
    label: raw.label ? String(raw.label) : undefined,
  }
}

function projectPath(id: string): string {
  return `projects/${id}.md`
}

function projectBrainstormPath(id: string): string {
  return `projects/${id}.brainstorm.json`
}

function projectBrainstormSeenPath(id: string): string {
  return `projects/${id}.brainstorm-seen.json`
}

function projectHistoryPath(id: string): string {
  return `projects/${id}.history.json`
}

/** Bounded plan history — the last N prior bodies (bakin#703). */
export const PLAN_HISTORY_CAP = 20

/** Brainstorm transcripts are working conversations, not archives —
 *  bounded so the per-row full-file rewrite stays cheap (bakin#706). */
export const BRAINSTORM_ROW_CAP = 300

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

const kickoffSchema = z.object({
  requestId: z.string().min(8).max(128),
  state: z.enum(['pending', 'started', 'settled']),
  message: z.string().optional(),
  agentId: z.string().optional(),
}).strict()

const operationsSchema = z.array(z.discriminatedUnion('kind', [z.object({
  kind: z.literal('add-checklist'), requestId: z.string().min(8).max(128),
  title: z.string().min(1), taskItemId: z.string().min(1),
  instanceId: z.string().uuid(), phase: z.literal('complete'),
}).strict(), z.object({
  kind: z.literal('promote-checklist'), requestId: z.string().min(8).max(128),
  title: z.string().min(1), taskItemId: z.string().min(1), instanceId: z.string().uuid(),
  taskId: z.string().min(1), assignee: z.string().optional(), workflowId: z.string().optional(),
  skipWorkflowReason: z.string().optional(), phase: z.enum(['reserved', 'complete']),
  retired: z.literal(true).optional(),
}).strict()]))

// Steward loop state (D22, D25, D26, D29). Strict: a hand-edited or
// corrupted record must fail loudly, never half-drive the loop.
const stewardSchema = z.object({
  openTaskId: z.string().min(1).optional(),
  phase: z.enum(['reserved', 'created']).optional(),
  frozen: z.object({ title: z.string(), assignee: z.string(), description: z.string() }).strict().optional(),
  reservedAt: z.string().optional(),
  fingerprint: z.string().optional(),
  lastFingerprint: z.string().optional(),
  lastStewardAt: z.string().optional(),
  runs: z.object({ date: z.string(), count: z.number().int().min(0) }).strict().optional(),
  capNotedOn: z.string().optional(),
}).strict()

const waitingOnSchema = z.object({
  kind: z.literal('input'),
  questionId: z.string().min(1),
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(z.string()).optional(),
  since: z.string(),
}).strict()

const gatesSchema = z.record(z.string(), z.object({
  approvalId: z.string().min(1),
  generation: z.number().int().min(1),
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  stewardTaskId: z.string().min(1).optional(),
  stewardAgentId: z.string().min(1).optional(),
}).strict())

export function parseProject(content: string): Project {
  // Split on YAML frontmatter fences
  const fenceRe = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/
  const match = content.match(fenceRe)
  if (!match) {
    throw new Error('Invalid project file: missing YAML frontmatter')
  }

  // js-yaml 5 throws on empty input; an empty frontmatter block is a valid, empty project header.
  const raw = (match[1].trim() === '' ? {} : load(match[1])) as Record<string, unknown>
  const body = match[2] || ''

  const tasks: ProjectTask[] = Array.isArray(raw.tasks)
    ? raw.tasks.map((t: Record<string, unknown>) => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
        instanceId: typeof t.instanceId === 'string' ? t.instanceId : undefined,
        description: t.description ? String(t.description) : undefined,
        taskId: t.taskId ? String(t.taskId) : undefined,
        checked: Boolean(t.checked),
      }))
    : []

  const assets: ProjectAsset[] = Array.isArray(raw.assets)
    ? raw.assets.map(parseAsset).filter((asset): asset is ProjectAsset => asset !== null)
    : []

  const fm: ProjectFrontmatter = {
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    titleSource: TITLE_SOURCES.includes(raw.titleSource as TitleSource) ? raw.titleSource as TitleSource : 'user',
    status: (['draft', 'active', 'completed', 'archived'].includes(String(raw.status)) ? String(raw.status) : 'draft') as ProjectFrontmatter['status'],
    created: String(raw.created || new Date().toISOString()),
    updated: String(raw.updated || new Date().toISOString()),
    owner: String(raw.owner || ''),
    tasks,
    assets,
    ...(raw.kickoff === undefined ? {} : { kickoff: kickoffSchema.parse(raw.kickoff) }),
    planRevision: Number.isInteger(raw.planRevision) && (raw.planRevision as number) >= 0 ? raw.planRevision as number : 0,
    ...(raw.planUpdatedBy === 'agent' || raw.planUpdatedBy === 'user' ? { planUpdatedBy: raw.planUpdatedBy } : {}),
    ...(typeof raw.planUpdatedAt === 'string' ? { planUpdatedAt: raw.planUpdatedAt } : {}),
    ...(raw.archivedFrom === 'draft' || raw.archivedFrom === 'active' || raw.archivedFrom === 'completed' ? { archivedFrom: raw.archivedFrom } : {}),
    ...(raw.operations === undefined ? {} : { operations: operationsSchema.parse(raw.operations) }),
    ...(raw.stewardPaused === true ? { stewardPaused: true } : {}),
    ...(raw.steward === undefined ? {} : { steward: stewardSchema.parse(raw.steward) }),
    ...(raw.waitingOn === undefined ? {} : { waitingOn: waitingOnSchema.parse(raw.waitingOn) }),
    ...(raw.replyPending === undefined ? {} : { replyPending: z.object({ questionId: z.string().min(1) }).strict().parse(raw.replyPending) }),
    ...(raw.gates === undefined ? {} : { gates: gatesSchema.parse(raw.gates) }),
  }

  return {
    ...fm,
    body: body.trim(),
    progress: computeProgress(tasks),
  }
}

export function serializeProject(project: Project): string {
  const { body, progress: _progress, ...fm } = project
  // Ensure tasks array is serialized correctly (omit undefined taskId)
  const cleanTasks = fm.tasks.map(t => {
    const item: Record<string, unknown> = { id: t.id, title: t.title, checked: t.checked }
    if (t.instanceId) item.instanceId = t.instanceId
    if (t.description) item.description = t.description
    if (t.taskId) item.taskId = t.taskId
    return item
  })

  // Omit empty assets array
  const cleanAssets = fm.assets.length > 0
    ? fm.assets.map(a => {
        const item: Record<string, unknown> = { assetId: a.assetId }
        if (a.label) item.label = a.label
        return item
      })
    : undefined

  const fmData = { ...fm, tasks: cleanTasks, assets: cleanAssets }
  if (!cleanAssets) delete (fmData as Record<string, unknown>).assets

  const frontmatter = dump(
    fmData,
    { lineWidth: -1, quoteStyle: 'double', forceQuotes: false },
  ).trim()

  return `---\n${frontmatter}\n---\n\n${body}\n`
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export interface ProjectRepository {
  readProject(id: string): Project | null
  readAllProjects(): Project[]
  writeProject(project: Project): void
  readBrainstormMessages(id: string): ProjectBrainstormMessage[]
  writeBrainstormMessages(id: string, messages: ProjectBrainstormMessage[]): void
  readSeen(id: string): ProjectSeen
  /** Merge fields into the seen sidecar — brainstorm and plan views share it. */
  updateSeen(id: string, patch: Partial<ProjectSeen>): void
  readLastAgentActivityTs(id: string): string | null
  /** The transcript ends on an open question card (no user reply after it). */
  readWaitingForUser(id: string): boolean
  readPlanHistory(id: string): PlanSnapshot[]
  /** Append one snapshot; retention keeps the newest PLAN_HISTORY_CAP plus the seen baseline. */
  appendPlanSnapshot(id: string, snapshot: PlanSnapshot): void
  deleteProjectFile(id: string): boolean
  projectStoragePath(id: string): string
  projectBrainstormStoragePath(id: string): string
  projectsGlob(): string
}

export class PlanHistoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Plan history is unavailable', { cause })
    this.name = 'PlanHistoryUnavailableError'
  }
}

export function createProjectRepository(storage: StorageAdapter): ProjectRepository {
  // The attention endpoint polls every project's transcript for its last
  // agent-activity timestamp — cache it against the sidecar's mtime+size so
  // steady-state polls never re-read/re-parse full transcripts (bakin#706).
  const lastAgentTsCache = new Map<string, { mtimeMs: number; size: number; ts: string | null; waiting: boolean }>()

  // Local so sibling methods can call them after destructuring (no `this`).
  function readBrainstormMessages(id: string): ProjectBrainstormMessage[] {
    const content = storage.read(projectBrainstormPath(id))
    if (!content) return []
    try {
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(normalizeConversationRow)
        .filter((message): message is ProjectBrainstormMessage => message !== null)
    } catch {
      return []
    }
  }

  /** Attention facts from one transcript read, cached against mtime+size. */
  function transcriptSignals(id: string): { ts: string | null; waiting: boolean } {
    const path = projectBrainstormPath(id)
    const stat = storage.stat?.(path)
    if (!stat) {
      lastAgentTsCache.delete(id)
      return { ts: null, waiting: false }
    }
    const cached = lastAgentTsCache.get(id)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
    const rows = readBrainstormMessages(id)
    // A turn that ends on a question card is agent activity too (D6a).
    const isQuestion = (row: ProjectBrainstormMessage) => row.kind === 'tool' && parseBakinQuestion(row.metadata?.bakinQuestion) !== null
    const ts = [...rows].reverse().find(r => r.kind === 'assistant' || r.kind === 'error' || isQuestion(r))?.ts ?? null
    let lastUser = -1
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.kind === 'user') { lastUser = i; break }
    const waiting = rows.slice(lastUser + 1).some(isQuestion)
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, ts, waiting }
    lastAgentTsCache.set(id, entry)
    return entry
  }

  function readSeen(id: string): ProjectSeen {
    const seen: ProjectSeen = { lastSeenAt: null, planSeenRevision: 0 }
    const content = storage.read(projectBrainstormSeenPath(id))
    if (!content) return seen
    try {
      const parsed = JSON.parse(content) as { lastSeenAt?: unknown; planSeenRevision?: unknown }
      if (typeof parsed.lastSeenAt === 'string') seen.lastSeenAt = parsed.lastSeenAt
      if (Number.isInteger(parsed.planSeenRevision) && (parsed.planSeenRevision as number) >= 0) seen.planSeenRevision = parsed.planSeenRevision as number
    } catch {
      // A corrupt sidecar reads as never-seen; the next view rewrites it.
    }
    return seen
  }

  function readPlanHistory(id: string): PlanSnapshot[] {
    try {
      const content = storage.read(projectHistoryPath(id))
      if (content == null) return []
      const parsed: unknown = JSON.parse(content)
      if (!Array.isArray(parsed) || !parsed.every(value => value && typeof value === 'object'
        && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))
        && (value.author === 'user' || value.author === 'agent') && typeof value.body === 'string'
        && (value.revision === undefined || Number.isInteger(value.revision)))) {
        throw new Error('Invalid plan history payload')
      }
      return parsed as PlanSnapshot[]
    } catch (cause) {
      throw new PlanHistoryUnavailableError(cause)
    }
  }

  return {
    readProject(id: string): Project | null {
      const content = storage.read(projectPath(id))
      return content ? parseProject(content) : null
    },

    readAllProjects(): Project[] {
      const files = (storage.list?.('projects') ?? []).filter(f => f.endsWith('.md'))
      const projects: Project[] = []
      for (const file of files) {
        try {
          const content = storage.read(`projects/${file}`)
          if (content) projects.push(parseProject(content))
        } catch {
          // Skip malformed project files
        }
      }
      return projects
    },

    writeProject(project: Project): void {
      storage.write(projectPath(project.id), serializeProject(project))
    },

    readBrainstormMessages,

    writeBrainstormMessages(id: string, messages: ProjectBrainstormMessage[]): void {
      storage.write(projectBrainstormPath(id), JSON.stringify(messages.slice(-BRAINSTORM_ROW_CAP), null, 2))
    },

    readSeen,

    updateSeen(id: string, patch: Partial<ProjectSeen>): void {
      const next = { ...readSeen(id), ...patch }
      storage.write(projectBrainstormSeenPath(id), JSON.stringify(next))
    },

    /** Timestamp of the last assistant/error row, mtime-cached. */
    readLastAgentActivityTs(id: string): string | null {
      return transcriptSignals(id).ts
    },

    readWaitingForUser(id: string): boolean {
      return transcriptSignals(id).waiting
    },

    readPlanHistory,

    /** Append one snapshot (oldest first), dropping past the cap. */
    appendPlanSnapshot(id: string, snapshot: PlanSnapshot): void {
      const all = [...readPlanHistory(id), snapshot]
      // The snapshot at the seen revision is the "Review changes" baseline
      // (D15): it survives the cap for as long as it is the baseline.
      const baseline = readSeen(id).planSeenRevision
      const newest = all.slice(-PLAN_HISTORY_CAP)
      const pinned = all.slice(0, -PLAN_HISTORY_CAP).find(entry => entry.revision === baseline)
      const history = pinned ? [pinned, ...newest] : newest
      storage.write(projectHistoryPath(id), JSON.stringify(history, null, 2))
    },

    deleteProjectFile(id: string): boolean {
      const path = projectPath(id)
      if (!storage.exists(path)) return false
      storage.remove?.(path)
      const brainstormPath = projectBrainstormPath(id)
      if (storage.exists(brainstormPath)) storage.remove?.(brainstormPath)
      const seenPath = projectBrainstormSeenPath(id)
      if (storage.exists(seenPath)) storage.remove?.(seenPath)
      const historyPath = projectHistoryPath(id)
      if (storage.exists(historyPath)) storage.remove?.(historyPath)
      return true
    },

    projectStoragePath: projectPath,
    projectBrainstormStoragePath: projectBrainstormPath,
    projectsGlob: () => storage.searchPath?.('projects/*.md') ?? 'projects/*.md',
  }
}

function normalizeConversationRow(value: unknown): ProjectBrainstormMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const ts = typeof raw.ts === 'string' && raw.ts ? raw.ts : new Date().toISOString()
  const opt = (key: string) => (typeof raw[key] === 'string' ? { [key]: raw[key] as string } : {})
  switch (raw.kind) {
    case 'user':
      return typeof raw.content === 'string' ? { kind: 'user', ts, content: raw.content } : null
    case 'assistant':
      return typeof raw.content === 'string'
        ? { kind: 'assistant', ts, content: raw.content, ...opt('turnId'), ...opt('agentId') }
        : null
    case 'tool':
      return typeof raw.toolName === 'string'
        ? {
            kind: 'tool',
            ts,
            toolName: raw.toolName,
            ...opt('turnId'),
            ...opt('agentId'),
            ...opt('callId'),
            ...opt('status'),
            ...opt('summary'),
            ...opt('inputPreview'),
            ...opt('outputPreview'),
            ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
            ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
              ? { metadata: raw.metadata as Record<string, unknown> }
              : {}),
          }
        : null
    case 'error':
      return typeof raw.message === 'string'
        ? { kind: 'error', ts, message: raw.message, ...opt('turnId'), ...opt('errorKind') }
        : null
    case 'aborted':
      return { kind: 'aborted', ts, ...opt('turnId') }
    default:
      // Pre-kit role-based rows: dropped (accepted degraded replay).
      return null
  }
}

export function projectToSummary(p: Project): ProjectSummary {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    owner: p.owner,
    progress: p.progress,
    taskCount: p.tasks.length,
    assetCount: p.assets.length,
    updated: p.updated,
  }
}
