/**
 * Workarounds for bugs in the pinned xterm 6.0.0, applied identically to
 * the browser terminal and the server's headless Screen. Each has a test
 * that fails once upstream fixes the bug (drop the patch then).
 */

interface ParserTerminal {
  parser: { registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void } }
}

/** The private xterm 6.0.0 internals the erase-above patch drives (checked at run time). */
interface InputHandlerInternals {
  _activeBuffer: { x: number; y: number; ybase: number; lines: { get(index: number): { isWrapped: boolean } | undefined } }
  _bufferService: { cols: number }
  _dirtyRowTracker: { markDirty(y: number): void }
  _restrictCursor(maxCol?: number): void
  _eraseInBufferLine(y: number, start: number, end: number, clearWrap: boolean, respectProtect: boolean): void
  _resetBufferLine(y: number, respectProtect: boolean): void
}

function inputHandler(terminal: object): InputHandlerInternals | undefined {
  const handler = (terminal as { _core?: { _inputHandler?: Partial<InputHandlerInternals> } })._core?._inputHandler
  return handler && typeof handler._eraseInBufferLine === 'function' && typeof handler._resetBufferLine === 'function'
    && typeof handler._restrictCursor === 'function' && handler._activeBuffer && handler._bufferService && handler._dirtyRowTracker
    ? handler as InputHandlerInternals : undefined
}

/**
 * xterm 6.0.0: ED 1 (erase above, CSI 1 J; selective: CSI ? 1 J) with the
 * cursor in the last column clears the wrap flag of `lines.get(y + 1)` — a
 * screen row used as a buffer index. With no scrollback on the bottom row
 * it throws and the terminal's write queue never runs again; with
 * scrollback it clears a history line's flag instead. Only that branch is
 * done here, correctly; everything else is xterm's own.
 */
export function patchEraseAbove(terminal: ParserTerminal & object): void {
  const erase = (respectProtect: boolean) => (params: (number | number[])[]) => {
    if (params[0] !== 1) return false
    const handler = inputHandler(terminal)
    if (!handler) return false
    const cols = handler._bufferService.cols
    handler._restrictCursor(cols)
    const buffer = handler._activeBuffer
    if (buffer.x + 1 < cols) return false
    handler._dirtyRowTracker.markDirty(buffer.y)
    handler._eraseInBufferLine(buffer.y, 0, cols, true, respectProtect)
    const below = buffer.lines.get(buffer.ybase + buffer.y + 1)
    if (below) below.isWrapped = false
    for (let y = buffer.y - 1; y >= 0; y--) handler._resetBufferLine(y, respectProtect)
    handler._dirtyRowTracker.markDirty(0)
    return true
  }
  terminal.parser.registerCsiHandler({ final: 'J' }, erase(false))
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'J' }, erase(true))
}

/**
 * xterm runs its parser from the write queue with no catch: one exception
 * (a bug, or a throwing handler) leaves the queue with callbacks that never
 * fire, so every later write, capture and drain hangs. This guards the
 * per-instance parse step: a failure is reported once, later parses do
 * nothing, and xterm's own bookkeeping still runs the write callbacks, so
 * the owner can reject instead of hanging.
 */
export function guardParser(terminal: object, onFailure: (error: unknown) => void): { readonly failed: boolean } {
  const handler = (terminal as { _core?: { _inputHandler?: { parse?: (data: unknown, promiseResult?: boolean) => unknown } } })._core?._inputHandler
  let failed = false
  const fail = (error: unknown) => { if (!failed) { failed = true; onFailure(error) } }
  if (handler && typeof handler.parse === 'function') {
    const parse = handler.parse.bind(handler)
    handler.parse = (data, promiseResult) => {
      if (failed) return undefined
      try {
        const result = parse(data, promiseResult)
        return result instanceof Promise ? result.catch((error: unknown) => { fail(error); return false }) : result
      } catch (error) {
        fail(error)
        return undefined
      }
    }
  }
  return { get failed() { return failed } }
}
