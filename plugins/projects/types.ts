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

/**
 * Who named the project (D9). `fallback` = the start screen's first-message
 * trim, `agent` = the lead named it, `user` = a human typed it. Agents may
 * rename only `fallback`/`agent` titles. Absent (pre-revamp files) reads as
 * `user`: those titles were typed by hand.
 */
export const TITLE_SOURCES = ['fallback', 'agent', 'user'] as const
export type TitleSource = (typeof TITLE_SOURCES)[number]

/** Who is writing: agent tool calls are held to the authority rules (D9a). */
export type MutationCaller = { kind: 'user' } | { kind: 'agent'; agentId: string }

/**
 * Kickoff receipt (D8): the start screen's first send. `requestId` dedupes a
 * retried create for the project's whole life; `message`/`agentId` ride along
 * until the first turn settles, then drop (the transcript holds them).
 */
export interface ProjectKickoff {
  requestId: string
  state: 'pending' | 'started' | 'settled'
  message?: string
  agentId?: string
}

export interface ProjectFrontmatter {
  id: string
  title: string
  titleSource: TitleSource
  status: ProjectStatus
  created: string
  updated: string
  owner: string
  tasks: ProjectTask[]
  assets: ProjectAsset[]
  kickoff?: ProjectKickoff
  /**
   * Plan revision (D15): bumps on every COMMITTED body change (no-op writes
   * never do; restores do). Absent in pre-revamp files ⇒ 0.
   */
  planRevision: number
  /** The status an archive left (D11) — Unarchive returns to it. */
  archivedFrom?: Exclude<ProjectStatus, 'archived'>
  planUpdatedBy?: 'agent' | 'user'
  planUpdatedAt?: string
  /** Private durable mutation receipts; omitted from browser projections. */
  operations?: (ChecklistAddOperation | ChecklistPromotionOperation)[]
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
  /** The plan revision this body WAS (D15); absent on pre-revamp snapshots. */
  revision?: number
}

/** Per-project "what the user has seen" sidecar; fields merge on write. */
export interface ProjectSeen {
  /** Last view of the brainstorm (unread replies). */
  lastSeenAt: string | null
  /** Plan revision the user last viewed — the "Plan updated" baseline (D15). */
  planSeenRevision: number
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
  /** Resume signals (D18). */
  doneCount?: number
  /** The lead asked a question the user has not answered. */
  waitingForYou?: boolean
  /** An agent revised the plan since the user last looked. */
  planUpdated?: boolean
}


/** A file one of the project's board tasks produced (D17) — derived, never stored. */
export interface ProducedFile {
  assetId: string
  type: string
  description: string
  taskId: string
}

/** A linked step's board task as the detail projection shows it. */
export interface ResolvedBoardTask {
  column: string
  title: string
  /** The assignee, when the task has one. */
  agent?: string
}

export interface ResolvedProjectAsset extends ProjectAsset {
  type: string
  description?: string
  tags?: string[]
  missing?: boolean
}

/** Hydrated detail projection; checklist descriptions retain their shared type. */
export interface ProjectDetailData extends Project {
  /** The plan revision the user last viewed (D15). */
  planSeenRevision?: number
  resolvedTasks: Record<string, ResolvedBoardTask | null>
  resolvedAssets: ResolvedProjectAsset[]
  brainstormMessages?: ProjectBrainstormMessage[]
}

export type ProjectPatch = Partial<Pick<Project, 'title' | 'owner' | 'status' | 'body'>>
export type ChecklistPatch = Partial<Pick<ProjectTask, 'title' | 'description'>>

export interface ChecklistAddOperation {
  kind: 'add-checklist'
  requestId: string
  title: string
  taskItemId: string
  instanceId: string
  phase: 'complete'
}

export interface ChecklistPromotionOperation {
  kind: 'promote-checklist'
  requestId: string
  taskItemId: string
  instanceId: string
  taskId: string
  title: string
  assignee?: string
  workflowId?: string
  skipWorkflowReason?: string
  phase: 'reserved' | 'complete'
}
