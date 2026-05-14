/**
 * Projects plugin — parser.
 * Parses project markdown files with YAML frontmatter and creates a
 * storage-backed repository for project file I/O.
 * Pure functions where possible — no side effects.
 */
import type { StorageAdapter } from '@makinbakin/sdk/types'
import yaml from 'js-yaml'
import type { Project, ProjectFrontmatter, ProjectTask, ProjectAsset, ProjectBrainstormMessage, ProjectSummary } from '../types'

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

function projectPath(id: string): string {
  return `projects/${id}.md`
}

function projectBrainstormPath(id: string): string {
  return `projects/${id}.brainstorm.json`
}

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
    ? raw.assets.map((a: Record<string, unknown>) => ({
        filename: String(a.filename || ''),
        label: a.label ? String(a.label) : undefined,
      }))
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
        const item: Record<string, unknown> = { filename: a.filename }
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
  deleteProjectFile(id: string): boolean
  projectStoragePath(id: string): string
  projectBrainstormStoragePath(id: string): string
  projectsGlob(): string
}

export function createProjectRepository(storage: StorageAdapter): ProjectRepository {
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

    readBrainstormMessages(id: string): ProjectBrainstormMessage[] {
      const content = storage.read(projectBrainstormPath(id))
      if (!content) return []
      try {
        const parsed = JSON.parse(content)
        if (!Array.isArray(parsed)) return []
        return parsed
          .map(normalizeBrainstormMessage)
          .filter((message): message is ProjectBrainstormMessage => message !== null)
      } catch {
        return []
      }
    },

    writeBrainstormMessages(id: string, messages: ProjectBrainstormMessage[]): void {
      storage.write(projectBrainstormPath(id), JSON.stringify(messages, null, 2))
    },

    deleteProjectFile(id: string): boolean {
      const path = projectPath(id)
      if (!storage.exists(path)) return false
      storage.remove?.(path)
      const brainstormPath = projectBrainstormPath(id)
      if (storage.exists(brainstormPath)) storage.remove?.(brainstormPath)
      return true
    },

    projectStoragePath: projectPath,
    projectBrainstormStoragePath: projectBrainstormPath,
    projectsGlob: () => storage.searchPath?.('projects/*.md') ?? 'projects/*.md',
  }
}

function normalizeBrainstormMessage(value: unknown): ProjectBrainstormMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'activity'
    ? raw.role
    : null
  const content = typeof raw.content === 'string' ? raw.content : null
  if (!role || content === null) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `msg-${Date.now().toString(36)}`
  const timestamp = typeof raw.timestamp === 'string' && raw.timestamp ? raw.timestamp : new Date().toISOString()
  return {
    id,
    role,
    content,
    ...(typeof raw.agentId === 'string' ? { agentId: raw.agentId } : {}),
    ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
    ...(raw.data !== undefined ? { data: raw.data } : {}),
    timestamp,
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
