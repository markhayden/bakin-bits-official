import { z } from 'zod'

export const createSchema = z.object({
  title: z.string().trim().min(1).max(100),
  cwd: z.string().min(1).max(4096),
  program: z.enum(['shell', 'claude', 'codex']).default('shell'),
  checkout: z.enum(['isolated', 'existing']).default('isolated'),
  agentId: z.string().min(1).max(100).optional(),
  taskId: z.string().min(1).max(100).optional(),
  projectId: z.string().min(1).max(100).optional(),
})
export type CreateInput = z.infer<typeof createSchema>
export type Principal = { kind: 'human'; id: string } | { kind: 'agent'; id: string }
/** What kind of screen claims the size: it names the authority in the header ("Sized by phone"). */
export const screenDevice = z.enum(['desktop', 'phone'])
export type SizeClaimant = { kind: 'browser'; device: z.infer<typeof screenDevice> } | { kind: 'native' }
export interface Session {
  revision?: number
  id: string
  title: string
  cwd: string
  program: CreateInput['program']
  agentId?: string
  taskId?: string
  projectId?: string
  owner: Principal
  generation: number
  inputSequence: number
  cols: number
  rows: number
  /** The viewer that sizes the grid (spec D2); absent until someone claims. */
  sizeAuthority?: { viewer: string } & SizeClaimant
  /** Bumped by every claim; a resize must carry the current epoch. */
  sizeEpoch: number
  /** Bumped by every actual dimension change; agents re-read after it moves. */
  sizeRevision: number
  state: 'running' | 'exited' | 'completed'
  createdAt: number
  lastActivityAt: number
  completedAt?: number
  worktreePath?: string
  cleanupReason?: string
  historyDeleted?: boolean
}
export interface TerminalSettings {
  enabledAgents?: Array<{ id: string }>
  /** Grid for sessions nobody's screen sized yet (agents, CLI without a TTY size). */
  defaultSize?: { cols: number; rows: number }
  maxSessions?: number
  maxWorktrees?: number
  idleDays?: number
}
export function terminalSettings(raw: Record<string, unknown>): TerminalSettings {
  const bounded = (value: unknown, fallback: number, max: number) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max ? (value as number) : fallback
  // `enabledAgents` is the array of enabled agent ids from the toggle grid.
  // Until the operator configures anything (undefined), the main agent is on;
  // an explicit empty array is respected.
  const stored = raw.enabledAgents
  const enabledAgents = Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100).map((id) => ({ id }))
    : [{ id: 'main' }]
  const within = (value: unknown, fallback: number, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fallback
  return {
    enabledAgents,
    defaultSize: { cols: within(raw.defaultCols, 200, 40, 400), rows: within(raw.defaultRows, 60, 10, 150) },
    maxSessions: bounded(raw.maxSessions, 10, 100),
    maxWorktrees: bounded(raw.maxWorktrees, 10, 100),
    idleDays: bounded(raw.idleDays, 30, 365),
  }
}
export const DAY = 86_400_000
export class TerminalError extends Error {
  constructor(message: string, readonly status = 409) { super(message) }
}
/** Input whose sequence was consumed but whose delivery failed: never retry it. */
export class DeliveryUncertainError extends TerminalError {
  constructor(message: string) { super(`${message}; the input may have been delivered — do not retry it`, 503) }
}

export function authorize(session: Session, principal: Principal, enabled: string[], write = false, generation?: number): void {
  if (principal.kind === 'agent' && (!enabled.includes(principal.id) || session.agentId !== principal.id)) {
    throw new TerminalError('Session not available to this agent', 403)
  }
  if (!write) return
  // The human is the operator, not the browser tab: any human client may drive
  // a human-owned session (so a phone or a second tab is never locked out),
  // while an agent-owned session admits only that exact agent. The generation
  // still invalidates input queued before a takeover.
  const ownerMatches = session.owner.kind === principal.kind
    && (principal.kind === 'agent' ? session.owner.id === principal.id : true)
  if (!ownerMatches || session.generation !== generation) {
    throw new TerminalError('Input ownership changed; refresh the session')
  }
}
