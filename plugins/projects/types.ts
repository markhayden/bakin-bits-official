/**
 * Projects plugin — type definitions.
 */

export const PROJECT_STATUSES = ['draft', 'active', 'completed', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export interface ProjectTask {
  id: string          // "t001", "t002" — auto-incrementing
  title: string
  /** Stable identity even when the display ID is reused after deletion. */
  instanceId?: string
  description?: string
  taskId?: string     // linked board task ID (8-char hex)
  checked: boolean
}

export interface ProjectAsset {
  assetId: string         // managed asset id (e.g., "20260327-hero-a1b2c3d4"); stable across versions
  label?: string          // optional human label / summary
}

export interface ProjectFrontmatter {
  id: string
  title: string
  status: ProjectStatus
  created: string
  updated: string
  owner: string
  tasks: ProjectTask[]
  assets: ProjectAsset[]
  /** Private durable mutation receipts; omitted from browser projections. */
  operations?: ChecklistAddOperation[]
}

export interface Project extends ProjectFrontmatter {
  body: string        // markdown after frontmatter
  progress: number    // 0-100, derived from tasks
}

/**
 * Brainstorm rows ARE the conversation kit's storable shape — the panel
 * folds and renders them directly, and the server's turn recorder produces
 * them. Old role-based rows are dropped on read (accepted: degraded replay
 * for pre-kit brainstorms; no compat shims).
 */
export type ProjectBrainstormMessage = import('@makinbakin/sdk/conversation').ConversationMessage

/** One plan-body snapshot (bakin#703): captured BEFORE every body write. */
export interface PlanSnapshot {
  ts: string
  author: 'agent' | 'user'
  body: string
}

export interface ProjectSummary {
  id: string
  title: string
  status: ProjectStatus
  owner: string
  progress: number
  taskCount: number
  assetCount: number
  updated: string
  /** Brainstorm attention (bakin#703): unseen agent reply / turn running. */
  brainstormUnread?: boolean
  brainstormStreaming?: boolean
}


export interface ResolvedProjectAsset extends ProjectAsset {
  type: string
  description?: string
  tags?: string[]
  missing?: boolean
}

/** Hydrated detail projection; checklist descriptions retain their shared type. */
export interface ProjectDetailData extends Project {
  resolvedTasks: Record<string, { column: string; title: string } | null>
  resolvedAssets: ResolvedProjectAsset[]
  brainstormMessages?: ProjectBrainstormMessage[]
}

export type ProjectEditableValues = Pick<Project, 'title' | 'owner' | 'status' | 'body'>
export type ProjectPatch = Partial<ProjectEditableValues>
export type ChecklistPatch = Partial<Pick<ProjectTask, 'title' | 'description'>>

export interface ChecklistAddOperation {
  kind: 'add-checklist'
  requestId: string
  title: string
  taskItemId: string
  instanceId: string
  phase: 'complete'
}
