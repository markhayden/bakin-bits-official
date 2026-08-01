/**
 * Projects plugin — parser.
 * Parses project markdown files with YAML frontmatter and creates a
 * storage-backed repository for project file I/O.
 * Pure functions where possible — no side effects.
 */
import type { StorageAdapter } from '@makinbakin/sdk/types'
import yaml from 'js-yaml'
import type { PlanSnapshot, Project, ProjectFrontmatter, ProjectTask, ProjectAsset, ProjectBrainstormMessage, ProjectSummary } from '../types'

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

export function parseProject(content: string): Project {
  // Split on YAML frontmatter fences
  const fenceRe = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/
  const match = content.match(fenceRe)
  if (!match) {
    throw new Error('Invalid project file: missing YAML frontmatter')
  }

  const raw = yaml.load(match[1]) as Record<string, unknown>
  const body = match[2] || ''

  const tasks: ProjectTask[] = Array.isArray(raw.tasks)
    ? raw.tasks.map((t: Record<string, unknown>) => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
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
    status: (['draft', 'active', 'completed', 'archived'].includes(String(raw.status)) ? String(raw.status) : 'draft') as ProjectFrontmatter['status'],
    created: String(raw.created || new Date().toISOString()),
    updated: String(raw.updated || new Date().toISOString()),
    owner: String(raw.owner || ''),
    tasks,
    assets,
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

  const frontmatter = yaml.dump(
    fmData,
    { lineWidth: -1, quotingType: '"', forceQuotes: false },
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
  readBrainstormSeen(id: string): string | null
  writeBrainstormSeen(id: string, lastSeenAt: string): void
  readLastAgentActivityTs(id: string): string | null
  readPlanHistory(id: string): PlanSnapshot[]
  appendPlanSnapshot(id: string, snapshot: PlanSnapshot): void
  deleteProjectFile(id: string): boolean
  projectStoragePath(id: string): string
  projectBrainstormStoragePath(id: string): string
  projectsGlob(): string
}

export function createProjectRepository(storage: StorageAdapter): ProjectRepository {
  // The attention endpoint polls every project's transcript for its last
  // agent-activity timestamp — cache it against the sidecar's mtime+size so
  // steady-state polls never re-read/re-parse full transcripts (bakin#706).
  const lastAgentTsCache = new Map<string, { mtimeMs: number; size: number; ts: string | null }>()

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

  function readPlanHistory(id: string): PlanSnapshot[] {
    const content = storage.read(projectHistoryPath(id))
    if (!content) return []
    try {
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? (parsed as PlanSnapshot[]) : []
    } catch {
      return []
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

    /** When the user last viewed this project's brainstorm (null = never). */
    readBrainstormSeen(id: string): string | null {
      const content = storage.read(projectBrainstormSeenPath(id))
      if (!content) return null
      try {
        const parsed = JSON.parse(content) as { lastSeenAt?: unknown }
        return typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : null
      } catch {
        return null
      }
    },

    writeBrainstormSeen(id: string, lastSeenAt: string): void {
      storage.write(projectBrainstormSeenPath(id), JSON.stringify({ lastSeenAt }))
    },

    /** Timestamp of the last assistant/error row, mtime-cached. */
    readLastAgentActivityTs(id: string): string | null {
      const path = projectBrainstormPath(id)
      const stat = storage.stat?.(path)
      if (!stat) {
        lastAgentTsCache.delete(id)
        return null
      }
      const cached = lastAgentTsCache.get(id)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ts
      const rows = readBrainstormMessages(id)
      const ts = [...rows].reverse().find(r => r.kind === 'assistant' || r.kind === 'error')?.ts ?? null
      lastAgentTsCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, ts })
      return ts
    },

    readPlanHistory,

    /** Append one snapshot (oldest first), dropping past the cap. */
    appendPlanSnapshot(id: string, snapshot: PlanSnapshot): void {
      const history = [...readPlanHistory(id), snapshot].slice(-PLAN_HISTORY_CAP)
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
