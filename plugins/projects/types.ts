/**
 * Projects plugin — type definitions.
 */

export type ProjectStatus = 'draft' | 'active' | 'completed' | 'archived'

export interface ProjectTask {
  id: string          // "t001", "t002" — auto-incrementing
  title: string
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
export type ProjectBrainstormMessage = import('@makinbakin/sdk/components').ConversationMessage

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
}
