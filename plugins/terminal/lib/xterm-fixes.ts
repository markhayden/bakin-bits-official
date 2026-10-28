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

type Internals = Record<string, unknown>
const core = (terminal: object): Internals | undefined => (terminal as { _core?: Internals })._core

interface BufferLineInternals { _extendedAttrs: Record<string, { urlId?: number } | undefined>; _combined: Record<string, unknown>; _data: Uint32Array }
interface BufferInternals { lines: { length: number; maxLength: number; get(index: number): BufferLineInternals | undefined }; _rows: number; _getCorrectBufferLength(rows: number): number }
const buffers = (terminal: object): { normal: BufferInternals; alt: BufferInternals } | undefined => {
  const value = core(terminal)?.buffers as { normal?: BufferInternals; alt?: BufferInternals } | undefined
  return value?.normal && value.alt ? { normal: value.normal, alt: value.alt } : undefined
}

/**
 * xterm 6.0.0: the cleared alternate buffer keeps a line store sized for the
 * rows when it was cleared; a resize while it is inactive does not update it,
 * so the next activation can hold more lines than the screen has. Normalise
 * it on every resize.
 */
export function patchAltBufferCapacity(terminal: { onResize(listener: () => void): { dispose(): void }; buffer: { active: { type: string } } } & object): void {
  terminal.onResize(() => {
    const all = buffers(terminal)
    if (!all || terminal.buffer.active.type !== 'normal' || all.alt.lines.length !== 0 || typeof all.alt._getCorrectBufferLength !== 'function') return
    all.alt.lines.maxLength = all.alt._getCorrectBufferLength(all.alt._rows)
  })
}

// BufferLine cell layout (xterm 6.0.0): 3 words per cell; content word bit 21
// marks combined (grapheme) content, bg word bit 28 marks extended attributes.
const COMBINED = 0x200000
const HAS_EXTENDED = 0x10000000

/**
 * xterm 6.0.0: a line's combined (grapheme) and extended-attribute maps keep
 * entries for cells that are no longer combined or extended, and reflow on
 * resize can pick those stale entries up. Purge them right before every
 * resize, so reflow only sees live data.
 */
export function patchReflowStaleMaps(terminal: { resize(cols: number, rows: number): void } & object): void {
  const resize = terminal.resize.bind(terminal)
  terminal.resize = (cols: number, rows: number) => {
    const all = buffers(terminal)
    if (all) for (const buffer of [all.normal, all.alt]) {
      for (let y = 0; y < buffer.lines.length; y++) {
        const line = buffer.lines.get(y)
        if (!line?._data) continue
        for (const key of Object.keys(line._combined ?? {})) if (!(line._data[Number(key) * 3]! & COMBINED)) delete line._combined[key]
        for (const key of Object.keys(line._extendedAttrs ?? {})) if (!(line._data[Number(key) * 3 + 2]! & HAS_EXTENDED)) delete line._extendedAttrs[key]
      }
    }
    resize(cols, rows)
  }
}

interface LinkEntry { id: number; key?: string; data: { id?: string }; lines: unknown[] }
interface LinkService { _removeMarkerFromLink(entry: LinkEntry, marker: unknown): void; _dataByLinkId: Map<number, LinkEntry>; _entriesWithId: Map<string, LinkEntry> }

/** Orphaned link entries a sweep waits for (beyond the ones still referenced at the last sweep). */
export const LINK_ORPHAN_LIMIT = 256

/**
 * xterm 6.0.0 keeps a link alive through markers on the lines it was printed
 * on; scroll-region operations move content but not those markers, so a link
 * can expire while its cells are still on screen. Losing the last marker now
 * makes the entry an orphan instead of deleting it. Once LINK_ORPHAN_LIMIT
 * new orphans have accumulated since the last sweep, a sweep deletes every
 * orphan nothing references: no extended cell in either buffer (a line's
 * attribute map keeps stale entries, so the cell's own bit decides) and not
 * the current pen (an open link prints its next character with it). A link
 * re-opened with the same id revives its entry.
 */
export function patchLinkLifetime(terminal: object): { orphans(): number; sweeps(): number; sweep(): void } {
  const service = core(terminal)?._oscLinkService as LinkService | undefined
  const orphans = new Set<LinkEntry>()
  // Sweep again only after new orphans accumulate, so links that stay
  // referenced never make every later expiry rescan the buffers.
  let threshold = LINK_ORPHAN_LIMIT
  let sweeps = 0
  const sweep = () => {
    const all = buffers(terminal)
    if (!service || !all) return
    sweeps++
    const referenced = new Set<number>()
    const pen = (core(terminal)?._inputHandler as { _curAttrData?: { extended?: { urlId?: number } } } | undefined)?._curAttrData?.extended?.urlId
    if (pen) referenced.add(pen)
    for (const buffer of [all.normal, all.alt]) for (let y = 0; y < buffer.lines.length; y++) {
      const line = buffer.lines.get(y)
      if (!line?._data) continue
      for (const [key, value] of Object.entries(line._extendedAttrs ?? {})) {
        if (value?.urlId && line._data[Number(key) * 3 + 2]! & HAS_EXTENDED) referenced.add(value.urlId)
      }
    }
    for (const entry of orphans) {
      if (entry.lines.length > 0) { orphans.delete(entry); continue }
      if (referenced.has(entry.id)) continue
      if (entry.key !== undefined) service._entriesWithId.delete(entry.key)
      service._dataByLinkId.delete(entry.id)
      orphans.delete(entry)
    }
    threshold = orphans.size + LINK_ORPHAN_LIMIT
  }
  if (service && typeof service._removeMarkerFromLink === 'function' && service._dataByLinkId instanceof Map) {
    service._removeMarkerFromLink = (entry, marker) => {
      const index = entry.lines.indexOf(marker)
      if (index === -1) return
      entry.lines.splice(index, 1)
      if (entry.lines.length > 0) return
      orphans.add(entry)
      if (orphans.size > threshold) sweep()
    }
  }
  return { orphans: () => [...orphans].filter(entry => entry.lines.length === 0).length, sweeps: () => sweeps, sweep }
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
  const handler = (terminal as { _core?: { _inputHandler?: { parse?: (data: unknown, promiseResult?: boolean) => unknown; _logSlowResolvingAsync?: (promise: Promise<unknown>) => void } } })._core?._inputHandler
  let failed = false
  const fail = (error: unknown) => { if (!failed) { failed = true; onFailure(error) } }
  // xterm also races an async handler's promise in a debug branch that
  // rethrows its rejection, unhandled. Keep only the warning; the rejection
  // is reported through the returned promise below.
  if (handler && typeof handler._logSlowResolvingAsync === 'function') {
    const log = handler._logSlowResolvingAsync.bind(handler)
    handler._logSlowResolvingAsync = (promise) => log(promise.catch(() => true))
  }
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

/** How many bytes at the end of `data` begin a UTF-8 sequence that is not complete yet. */
export function incompleteUtf8Tail(data: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, data.length); back++) {
    const byte = data[data.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return length > back ? back : 0
  }
  return 0
}

/** Largest piece handed to xterm: below its own 128 KiB parse split, so it never cuts a codepoint itself. */
export const WRITE_PIECE = 64 * 1024

/**
 * xterm 6.0.0: a write that ends inside a UTF-8 sequence loses the grapheme
 * join state when the sequence completes in the next write (a ZWJ split
 * after `E2 80` turns 🧑‍💻 from 2 cells into 4); xterm also splits large
 * writes itself at 128 KiB, anywhere. So every write reaches xterm in pieces
 * of at most WRITE_PIECE that end on a codepoint boundary (a string on a
 * surrogate pair's boundary); an incomplete UTF-8 tail is carried into the
 * next byte write. A string write or a reset drops a carried tail: those
 * bytes can no longer complete.
 */
export function patchUtf8Boundaries(terminal: { write(data: string | Uint8Array, callback?: () => void): void; reset(): void }): void {
  const write = terminal.write.bind(terminal)
  const reset = terminal.reset.bind(terminal)
  let carry: Uint8Array | undefined
  // Pieces in order; the caller's callback rides the last, so it fires after all of them are parsed.
  const pieces = (data: string | Uint8Array, boundary: (end: number) => number, callback?: () => void) => {
    if (data.length === 0) { write(data, callback); return }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + WRITE_PIECE, data.length)
      if (end < data.length) end = boundary(end)
      write(data.slice(offset, end), end === data.length ? callback : undefined)
      offset = end
    }
  }
  terminal.write = (data, callback) => {
    if (typeof data === 'string') {
      carry = undefined
      // Never between a surrogate pair's halves.
      pieces(data, (end) => (/[\ud800-\udbff]/.test(data[end - 1]!) ? end - 1 : end), callback)
      return
    }
    let bytes = data
    if (carry) {
      bytes = new Uint8Array(carry.length + data.length)
      bytes.set(carry)
      bytes.set(data, carry.length)
    }
    const tail = incompleteUtf8Tail(bytes)
    carry = tail ? bytes.slice(bytes.length - tail) : undefined
    const complete = tail ? bytes.subarray(0, bytes.length - tail) : bytes
    // Back off to the lead byte of a codepoint that would be cut: at most
    // three bytes (invalid input with longer runs is cut where it is).
    pieces(complete, (end) => {
      for (let back = 0; back < 3; back++) if ((complete[end - back]! & 0xc0) !== 0x80) return end - back
      return end
    }, callback)
  }
  terminal.reset = () => { carry = undefined; reset() }
}
