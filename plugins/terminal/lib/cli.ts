/**
 * `bakin terminal new | attach | ls` (spec D6): continue a session in a
 * terminal app on this Mac. `new` and `attach` are launch commands — the
 * route prepares a single-use attach reservation and answers the tmux
 * arguments; the core CLI runs Bakin's managed tmux in the caller's terminal
 * and confirms the child's pid (lib/sessions.ts admits it).
 */
import { basename } from 'node:path'
import { approvalProvenanceFromRequest } from '@makinbakin/sdk/routing'
import { z } from 'zod'
import { attachCommand, shortId, TerminalError, type Principal, type Session } from './contracts'
import type { NativeClient } from './processes'
import type { Sessions } from './sessions'

/** Only the operator, from their own terminal (`--as human`), attaches a terminal app. */
export function operator(request: Request): Principal {
  const { actor } = approvalProvenanceFromRequest(request)
  if (actor.kind === 'agent') throw new TerminalError('Refused in an agent context; terminal apps are for the operator', 403)
  if (actor.kind !== 'operator-declared') throw new TerminalError('This command acts as you: add --as human', 403)
  return { kind: 'human', id: 'cli' }
}

/** What the core CLI posts to a launch route. */
const launchBody = <T extends z.ZodTypeAny>(params: T) => z.object({ params, caller: z.object({
  cwd: z.string().min(1).max(4096),
  cols: z.number().int().min(1).max(10_000),
  rows: z.number().int().min(1).max(10_000),
}) })
export const newBody = launchBody(z.object({
  title: z.string().optional(),
  program: z.enum(['shell', 'claude', 'codex']).optional(),
  worktree: z.boolean().optional(),
  agent: z.string().optional(),
}).strict())
export const attachBody = launchBody(z.object({ ref: z.string().min(1).max(200) }).strict())
export const confirmBody = z.object({ token: z.string().min(16).max(256), pid: z.number().int().positive() })

/**
 * A full id wins; otherwise a unique id prefix of at least 8 characters or an
 * exact title, among running sessions. Ambiguity lists the candidates.
 */
export function resolveRef(sessions: Session[], ref: string): Session {
  const exact = sessions.find((session) => session.id === ref)
  if (exact) return exact
  const running = sessions.filter((session) => session.state === 'running')
  const matches = running.filter((session) => session.title === ref
    || (ref.length >= 8 && (session.id.startsWith(ref) || session.id.replace(/^terminal-/, '').startsWith(ref))))
  if (matches.length === 1) return matches[0]!
  if (!matches.length) throw new TerminalError(`No running session matches "${ref}". bakin terminal ls lists them`, 404)
  throw new TerminalError(`Several sessions match "${ref}"; use an id:\n${matches.map((session) => `  ${session.id}  ${session.title}`).join('\n')}`, 409)
}

/** `bakin terminal new` defaults: here, a shell, the existing checkout unless --worktree, titled after the directory. */
export function newSessionInput(body: z.infer<typeof newBody>): Record<string, unknown> {
  const { params, caller } = body
  return {
    title: params.title ?? basename(caller.cwd) ?? 'Terminal',
    cwd: caller.cwd,
    program: params.program ?? 'shell',
    checkout: params.worktree ? 'isolated' : 'existing',
    ...(params.agent ? { agentId: params.agent } : {}),
  }
}

/** The launch answer: tmux's arguments and where to confirm the pid. */
export async function launch(manager: Sessions, id: string, principal: Principal): Promise<{ args: string[]; confirm: { path: string; token: string }; recovery?: string }> {
  const { args, token } = await manager.reserveAttach(id, principal)
  return { args, confirm: { path: '/cli/confirm', token } }
}

/**
 * `new` starts the program at this terminal's size (the app claims it on
 * attach) and keeps a session it created even when attaching fails, saying
 * how to attach — before the launch (here) or after it (the CLI prints
 * `recovery`). Never retried.
 */
export async function createAndLaunch(manager: Sessions, body: z.infer<typeof newBody>, principal: Principal): Promise<Awaited<ReturnType<typeof launch>>> {
  const session = await manager.create(newSessionInput(body), principal, { cols: body.caller.cols, rows: body.caller.rows, kind: 'native' })
  const recovery = `Session ${shortId(session)} is running in Bakin. Attach with: ${attachCommand(session)}`
  try {
    return { ...await launch(manager, session.id, principal), recovery }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TerminalError(`Created the session but could not attach: ${reason}. ${recovery}`, error instanceof TerminalError ? error.status : 503)
  }
}

const owner = (session: Session) => session.owner.kind === 'human' ? 'you' : session.owner.id

/** `bakin terminal ls`: one row per session, terminal apps counted without Bakin's own clients. */
export function sessionTable(sessions: Session[], natives: (id: string) => NativeClient[], home = process.env.HOME ?? ''): string {
  if (!sessions.length) return 'No terminal sessions. Start one with: bakin terminal new --as human'
  const rows = [['ID', 'TITLE', 'PROGRAM', 'OWNER', 'STATE', 'SIZE', 'DIRECTORY', 'APPS'], ...sessions.map((session) => [
    shortId(session),
    session.title,
    session.program,
    owner(session),
    session.state,
    `${session.cols}×${session.rows}`,
    `${home && session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd}${session.worktreePath ? ' (worktree)' : ''}`,
    String(natives(session.id).length),
  ])]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join('  ')).join('\n')
}
