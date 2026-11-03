import { z } from 'zod'
import { screenDevice, TerminalError, type Principal } from './contracts'
import type { Sessions, StartSize } from './sessions'
import { UPLOAD_LIMITS } from './uploads'

export function human(request: Request): Principal {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  const id = request.headers.get('x-bakin-terminal-client')
  if ((origin && origin !== new URL(request.url).origin) || (site && site !== 'same-origin') || !id || !/^[a-zA-Z0-9-]{16,100}$/.test(id)) {
    throw new TerminalError('Same-origin Terminal client required', 403)
  }
  return { kind: 'human', id }
}

/** POST /sessions `size`: the creating screen's grid, so the program starts at the size it is seen at. */
export function creatingScreen(raw: unknown): StartSize | undefined {
  const size = z.object({ cols: z.number().int(), rows: z.number().int(), device: screenDevice }).safeParse(raw)
  return size.success ? { ...size.data, kind: 'browser' } : undefined
}

/**
 * Lifecycle and ownership commands. Browser input and resizes ride the
 * viewer socket (lib/socket.ts); agents type through `agentCommand`.
 */
export const commandSchema = z.object({
  id: z.string().min(1).max(100),
  operation: z.enum(['take', 'return', 'assign', 'complete', 'terminate', 'delete-history', 'delete', 'acknowledge', 'remove-upload']),
  generation: z.number().int().nonnegative().optional(),
  sequence: z.number().int().positive().optional(),
  data: z.string().max(65536).optional(),
  agentId: z.string().min(1).max(100).optional(),
  /** `acknowledge`: the attention occurrence shown. */
  occurrence: z.number().int().positive().optional(),
  /** `remove-upload`: the image's generated name. */
  name: z.string().min(1).max(100).optional(),
})

export async function command(manager: Sessions, raw: unknown, principal: Principal): Promise<unknown> {
  const input = commandSchema.parse(raw)
  switch (input.operation) {
    case 'take': case 'return': case 'assign': return manager.control(input.id, principal, input.operation, input.agentId)
    case 'complete': case 'terminate': return manager.finish(input.id, principal, input.generation ?? -1, input.operation === 'terminate')
    case 'delete-history': await manager.deleteHistory(input.id, principal); return { deleted: true }
    case 'delete': await manager.deleteSession(input.id, principal); return { deleted: true }
    case 'acknowledge':
      if (input.occurrence === undefined) throw new TerminalError('The attention occurrence to acknowledge is required', 400)
      return manager.acknowledge(input.id, principal, input.occurrence)
    case 'remove-upload':
      if (!input.name || input.generation === undefined) throw new TerminalError('The image and generation are required', 400)
      return manager.removeUpload(input.id, principal, input.generation, input.name)
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

/**
 * `POST /upload?id=&generation=`: the image's bytes as the body. Read at most
 * one byte past the limit, so an oversize body is refused without being held.
 */
export async function uploadImage(manager: Sessions, request: Request, principal: Principal): Promise<unknown> {
  const url = new URL(request.url)
  const id = z.string().min(1).max(100).parse(url.searchParams.get('id'))
  const generation = Number(z.string().regex(/^\d{1,15}$/).parse(url.searchParams.get('generation')))
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (declared > UPLOAD_LIMITS.imageBytes) throw new TerminalError('Images are at most 10 MB', 413)
  return manager.upload(id, principal, generation, () => readCapped(request, UPLOAD_LIMITS.imageBytes))
}
async function readCapped(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()
  // One buffer, grown by doubling up to the limit: each chunk is copied in and let go, so however the body
  // is split, at most about twice the image is held.
  let buffer = new Uint8Array(Math.min(limit, 64 * 1024))
  let total = 0
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    if (total + chunk.length > limit) throw new TerminalError('Images are at most 10 MB', 413)
    if (total + chunk.length > buffer.length) {
      const grown = new Uint8Array(Math.min(limit, Math.max(buffer.length * 2, total + chunk.length)))
      grown.set(buffer.subarray(0, total))
      buffer = grown
    }
    buffer.set(chunk, total)
    total += chunk.length
  }
  return buffer.subarray(0, total)
}
