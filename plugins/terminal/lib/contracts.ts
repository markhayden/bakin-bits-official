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
  maxSessions?: number
  maxWorktrees?: number
  idleDays?: number
}
export function terminalSettings(raw: TerminalSettings): TerminalSettings {
  const bounded = (value: number | undefined, fallback: number, max: number) => Number.isInteger(value) && value! >= 1 && value! <= max ? value : fallback
  return {
    enabledAgents: Array.isArray(raw.enabledAgents) ? raw.enabledAgents.filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0 && entry.id.length <= 100) : [],
    maxSessions: bounded(raw.maxSessions, 10, 100),
    maxWorktrees: bounded(raw.maxWorktrees, 10, 100),
    idleDays: bounded(raw.idleDays, 30, 365),
  }
}
export const DAY = 86_400_000
export class TerminalError extends Error {
  constructor(message: string, readonly status = 409) { super(message) }
}

export function authorize(session: Session, principal: Principal, enabled: string[], write = false, generation?: number): void {
  if (principal.kind === 'agent' && (!enabled.includes(principal.id) || session.agentId !== principal.id)) {
    throw new TerminalError('Session not available to this agent', 403)
  }
  if (write && (session.owner.kind !== principal.kind || session.owner.id !== principal.id || session.generation !== generation)) {
    throw new TerminalError('Input ownership changed; refresh the session')
  }
}
