import { z } from 'zod'
import { TerminalError, type Principal } from './contracts'
import type { Sessions } from './sessions'

export function human(request: Request): Principal {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  const id = request.headers.get('x-bakin-terminal-client')
  if ((origin && origin !== new URL(request.url).origin) || (site && site !== 'same-origin') || !id || !/^[a-zA-Z0-9-]{16,100}$/.test(id)) {
    throw new TerminalError('Same-origin Terminal client required', 403)
  }
  return { kind: 'human', id }
}

/**
 * Lifecycle and ownership commands. Browser input and resizes ride the
 * viewer socket (lib/socket.ts); agents type through `agentCommand`.
 */
export const commandSchema = z.object({
  id: z.string().min(1).max(100),
  operation: z.enum(['take', 'return', 'assign', 'complete', 'terminate', 'delete-history', 'delete']),
  generation: z.number().int().nonnegative().optional(),
  sequence: z.number().int().positive().optional(),
  data: z.string().max(65536).optional(),
  agentId: z.string().min(1).max(100).optional(),
})

export async function command(manager: Sessions, raw: unknown, principal: Principal): Promise<unknown> {
  const input = commandSchema.parse(raw)
  switch (input.operation) {
    case 'take': case 'return': case 'assign': return manager.control(input.id, principal, input.operation, input.agentId)
    case 'complete': case 'terminate': return manager.finish(input.id, principal, input.generation ?? -1, input.operation === 'terminate')
    case 'delete-history': await manager.deleteHistory(input.id, principal); return { deleted: true }
    case 'delete': await manager.deleteSession(input.id, principal); return { deleted: true }
  }
}

const agentCommandSchema = commandSchema.extend({
  operation: z.enum(['write', 'interrupt', 'complete', 'terminate']),
})

/** The agent tool's session operations: explicit-sequence input plus lifecycle. Agents never size a session (spec D3). */
export async function agentCommand(manager: Sessions, raw: unknown, principal: Principal): Promise<unknown> {
  const input = agentCommandSchema.parse(raw)
  switch (input.operation) {
    case 'write': case 'interrupt':
      if (input.generation === undefined || input.sequence === undefined) throw new TerminalError('Generation and input sequence required', 400)
      return manager.write(input.id, principal, input.generation, input.sequence, input.operation === 'interrupt' ? '\x03' : input.data ?? '')
    case 'complete': case 'terminate': return manager.finish(input.id, principal, input.generation ?? -1, input.operation === 'terminate')
  }
}

export function failure(error: unknown): Response {
  const status = error instanceof TerminalError ? error.status : error instanceof z.ZodError ? 400 : 500
  return Response.json({ error: error instanceof TerminalError ? error.message : status === 400 ? 'Invalid terminal request' : 'Terminal operation failed' }, { status })
}
