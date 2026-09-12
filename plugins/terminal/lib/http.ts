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

export const commandSchema = z.object({
  id: z.string().min(1).max(100),
  operation: z.enum(['take', 'return', 'assign', 'write', 'resize', 'interrupt', 'complete', 'terminate', 'delete-history', 'delete']),
  generation: z.number().int().nonnegative().optional(),
  sequence: z.number().int().positive().optional(),
  data: z.string().max(65536).optional(),
  agentId: z.string().min(1).max(100).optional(),
  cols: z.number().int().min(20).max(400).optional(),
  rows: z.number().int().min(5).max(150).optional(),
})

export async function command(manager: Sessions, raw: unknown, principal: Principal): Promise<unknown> {
  const input = commandSchema.parse(raw)
  switch (input.operation) {
    case 'take': case 'return': case 'assign': return manager.control(input.id, principal, input.operation, input.agentId)
    case 'write': case 'interrupt':
      if (input.generation === undefined || input.sequence === undefined) throw new TerminalError('Generation and input sequence required', 400)
      return manager.write(input.id, principal, input.generation, input.sequence, input.operation === 'interrupt' ? '\x03' : input.data ?? '')
    case 'resize': return manager.resize(input.id, principal, input.generation ?? -1, input.cols ?? 100, input.rows ?? 30)
    case 'complete': case 'terminate': return manager.finish(input.id, principal, input.generation ?? -1, input.operation === 'terminate')
    case 'delete-history': await manager.deleteHistory(input.id, principal); return { deleted: true }
    case 'delete': await manager.deleteSession(input.id, principal); return { deleted: true }
  }
}

export function failure(error: unknown): Response {
  const status = error instanceof TerminalError ? error.status : error instanceof z.ZodError ? 400 : 500
  return Response.json({ error: error instanceof TerminalError ? error.message : status === 400 ? 'Invalid terminal request' : 'Terminal operation failed' }, { status })
}

/** Pull-based streaming bounds a slow client's queue to one output page. */
export async function stream(manager: Sessions, request: Request): Promise<Response> {
  const principal = human(request)
  const id = new URL(request.url).searchParams.get('id') ?? ''
  const session = manager.get(id, principal)
  let cursor = 0
  let initial = true
  let stopped = false
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stopped || request.signal.aborted) { controller.close(); return }
      try {
        if (initial && session.state === 'running') {
          const snapshot = await manager.screen(id, principal)
          cursor = snapshot.cursor
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...snapshot, type: 'snapshot', data: Buffer.from(snapshot.data).toString('base64') })}\n\n`))
        } else {
          const output = manager.output(id, principal, cursor)
          if (output.truncated && output.session.state === 'running') throw new TerminalError('Output gap; reconnect required')
          cursor = output.cursor
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...output, type: 'output' })}\n\n`))
          await Bun.sleep(100)
        }
        initial = false
      } catch {
        stopped = true
        controller.enqueue(encoder.encode('data: {"type":"error","error":"Terminal stream unavailable"}\n\n'))
        controller.close()
      }
    },
    cancel() { stopped = true },
  }, { highWaterMark: 0 })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
}
