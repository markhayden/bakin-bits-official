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
/** A cell's (or the pen's) bg bit: it has an extended-attribute entry (xterm 6.0.0's packing). */
export const HAS_EXTENDED = 0x10000000

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
 * re-opened with the same id revives its entry. Orphans still referenced at
 * a sweep wait for the next one: the owner sweeps periodically (sliced,
 * `sweepSteps`) while any orphan remains, so ones erased since are reclaimed
 * without new links arriving.
 */
export function patchLinkLifetime(terminal: object): { orphans(): number; sweeps(): number; sweep(): void; sweepSteps(): Generator<void, void> } {
  const service = core(terminal)?._oscLinkService as LinkService | undefined
  const orphans = new Set<LinkEntry>()
  // Sweep again only after new orphans accumulate, so links that stay
  // referenced never make every later expiry rescan the buffers.
  let threshold = LINK_ORPHAN_LIMIT
  let sweeps = 0
  const pen = () => (core(terminal)?._inputHandler as { _curAttrData?: { extended?: { urlId?: number } } } | undefined)?._curAttrData?.extended?.urlId
  // A resize reflows lines under a walk in progress.
  let layout = 0
  ;(terminal as { onResize?(listener: () => void): unknown }).onResize?.(() => { layout++ })
  // A step per line; the owner serializes writes with it. Only a revived
  // entry (it has lines again) or the pen can reference an orphan, and both
  // are checked once the walk is done. A resize during the walk can move a
  // line behind it: nothing is deleted then, and the next sweep starts over.
  function* sweepSteps(): Generator<void, void> {
    const all = buffers(terminal)
    if (!service || !all) return
    const started = layout
    sweeps++
    const referenced = new Set<number>()
    for (const buffer of [all.normal, all.alt]) for (let y = 0; y < buffer.lines.length; y++) {
      const line = buffer.lines.get(y)
      if (!line?._data) continue
      for (const [key, value] of Object.entries(line._extendedAttrs ?? {})) {
        if (value?.urlId && line._data[Number(key) * 3 + 2]! & HAS_EXTENDED) referenced.add(value.urlId)
      }
      yield
    }
    if (layout !== started) return
    const current = pen()
    if (current) referenced.add(current)
    for (const entry of orphans) {
      if (entry.lines.length > 0) { orphans.delete(entry); continue }
      if (referenced.has(entry.id)) continue
      if (entry.key !== undefined) service._entriesWithId.delete(entry.key)
      service._dataByLinkId.delete(entry.id)
      orphans.delete(entry)
    }
    threshold = orphans.size + LINK_ORPHAN_LIMIT
  }
  const sweep = () => { for (const _ of sweepSteps()) { /* run to completion */ } }
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
  return { orphans: () => [...orphans].filter(entry => entry.lines.length === 0).length, sweeps: () => sweeps, sweep, sweepSteps }
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

/**
 * xterm 6.0.0's UTF-8 decoder counts the bytes it held from the previous
 * write by their payload: a continuation byte carrying no payload bits
 * (0x80, as in ZWJ, E2 80 8D) ends the count early, so it reads ahead too
 * far, takes the next character's lead byte for a bad continuation and
 * drops the held character — a write split after `E2 80` loses the ZWJ
 * (🧑‍💻 then takes 4 cells instead of 2). The held bytes are prepended to the
 * next input and decoded with it, by the decoder's correct main loop.
 */
export function patchUtf8Decoder(terminal: object): void {
  const decoder = (core(terminal)?._inputHandler as { _utf8Decoder?: { interim: Uint8Array; decode(input: Uint8Array, target: Uint32Array): number } } | undefined)?._utf8Decoder
  if (!decoder || typeof decoder.decode !== 'function') return
  const decode = decoder.decode.bind(decoder)
  decoder.decode = (input, target) => {
    const empty = decoder.interim.indexOf(0)
    const held = empty === -1 ? decoder.interim.length : empty
    if (!held || !input.length) return decode(input, target)
    const merged = new Uint8Array(held + input.length)
    merged.set(decoder.interim.subarray(0, held))
    merged.set(input, held)
    decoder.interim.fill(0)
    // One codepoint completes from the held bytes and at least one input byte, so `target` (sized for the input) holds the result.
    return decode(merged, target)
  }
}

const tabStopState = new WeakMap<object, { get(): number | undefined; set(value: number | undefined): void }>()
/**
 * The width the alternate screen was entered at (patchSharedTabStops):
 * leaving it at another width resets the stops. State outside xterm, so a
 * checkpoint carries it and a restore sets it.
 */
export const altEnteredCols = (terminal: object): number | undefined => tabStopState.get(terminal)?.get()
export const setAltEnteredCols = (terminal: object, cols: number | undefined): void => tabStopState.get(terminal)?.set(cols)

/**
 * xterm 6.0.0 keeps tab stops per buffer and resets the alternate buffer's
 * on every switch (it clears the buffer, stops included, before saying it
 * switched); tmux has one set for the pane. Each switch hands the stops of
 * the buffer being left to the one being activated — except leaving an
 * alternate screen whose width changed since it was entered: tmux restores
 * the saved width then, which resets the stops to the defaults.
 */
export function patchSharedTabStops(terminal: object): void {
  type Tabs = Record<number, boolean | undefined>
  interface BufferSet { normal: { tabs: Tabs; setupTabStops(column?: number): void }; alt: { tabs: Tabs }; active: unknown; activateNormalBuffer(): void; activateAltBuffer(fill?: unknown): void }
  const set = core(terminal)?.buffers as BufferSet | undefined
  if (!set || typeof set.activateNormalBuffer !== 'function' || typeof set.activateAltBuffer !== 'function') return
  const cols = () => (core(terminal)?._bufferService as { cols?: number } | undefined)?.cols
  const toNormal = set.activateNormalBuffer.bind(set)
  const toAlt = set.activateAltBuffer.bind(set)
  let enteredAt: number | undefined
  tabStopState.set(terminal, { get: () => enteredAt, set: (value) => { enteredAt = value } })
  set.activateNormalBuffer = () => {
    const leaving = set.active === set.alt ? { ...set.alt.tabs } : undefined
    toNormal()
    if (!leaving) return
    if (cols() === enteredAt) set.normal.tabs = leaving
    else set.normal.setupTabStops()
  }
  set.activateAltBuffer = (fill) => {
    const leaving = set.active === set.normal ? { ...set.normal.tabs } : undefined
    toAlt(fill)
    if (!leaving) return
    enteredAt = cols()
    set.alt.tabs = leaving
  }
}

interface PrintLine { getWidth(index: number): number; setCellFromCodepoint(index: number, codepoint: number, width: number, attributes: unknown): void }
interface PrintInternals {
  print(data: Uint32Array, start: number, end: number): void
  _activeBuffer: { x: number; y: number; ybase: number; lines: { get(index: number): PrintLine | undefined } }
  _parser: { parse(data: Uint32Array, length: number, promiseResult?: boolean): unknown }
}

/**
 * xterm 6.0.0: every print call first clears a wide cell before the cursor
 * (so a character never overwrites half of one), but a run of printing
 * inside one call does not — so where a write boundary splits a run, the
 * same bytes lay out differently by chunking (a cluster at the margin with
 * wraparound off loses its base; a wide character overwritten in its
 * second cell loses its first). A print that continues the previous parse
 * chunk's final print (that chunk ended in the middle of a printing run,
 * and this one starts with it) skips the clear, as the unsplit run would.
 * Prints after any escape or control are untouched.
 */
export function patchChunkedPrintClear(terminal: object): void {
  const handler = core(terminal)?._inputHandler as PrintInternals | undefined
  const parser = handler?._parser
  if (!handler || !parser || typeof handler.print !== 'function' || typeof parser.parse !== 'function') return
  const print = handler.print.bind(handler)
  const parse = parser.parse.bind(parser)
  // Where the previous chunk's last print ended, that chunk's length, and whether this chunk's first print continues it.
  let printedTo = -1
  let chunkLength = 0
  let continues = false
  parser.parse = (data, length, promiseResult) => {
    // A chunk that decoded to nothing (a partial UTF-8 write) is no parser action: the run continues past it.
    if (length === 0) return parse(data, length, promiseResult)
    continues = printedTo === chunkLength
    printedTo = -1
    chunkLength = length
    return parse(data, length, promiseResult)
  }
  handler.print = (data, start, end) => {
    const first = continues && start === 0
    continues = false
    printedTo = end
    const buffer = handler._activeBuffer
    const x = buffer.x
    const line = first && x > 0 ? buffer.lines.get(buffer.ybase + buffer.y) : undefined
    if (!line || line.getWidth(x - 1) !== 2) { print(data, start, end); return }
    const set = line.setCellFromCodepoint
    let leading = true
    // The clear is print's first cell write: skip exactly that one.
    line.setCellFromCodepoint = function (index, codepoint, width, attributes) {
      const clear = leading && index === x - 1 && codepoint === 0 && width === 1
      leading = false
      if (!clear) set.call(this, index, codepoint, width, attributes)
    }
    try { print(data, start, end) } finally { delete (line as Partial<PrintLine>).setCellFromCodepoint }
  }
}

/**
 * xterm 6.0.0 places its input textarea (IME, the software keyboard, focus
 * scrolling) only when the cursor moves after `open()`. A terminal written
 * before it is opened (the raw path's picture, replayed unseen and shown at
 * its barrier) leaves it unplaced until new output moves the cursor: place
 * it once, from the cursor the picture left.
 */
export function syncTextarea(terminal: object): void {
  ;(core(terminal) as { _syncTextArea?(): void } | undefined)?._syncTextArea?.()
}

const altEntries = new WeakMap<object, 'saved' | 'unsaved'>()
/**
 * How the alternate screen now active was entered: `saved` by DECSET 1049
 * (the normal screen's cursor was saved for the return), `unsaved` by 47 or
 * 1047. A width rebase (lib/geometry.ts) takes the normal screen's return
 * slot from tmux only for a saved entry.
 */
export const altEntry = (terminal: object): 'saved' | 'unsaved' | undefined => altEntries.get(terminal)
/** Set by a restore (the checkpoint carries it: its serializer enters the alternate screen by 47). */
export const setAltEntry = (terminal: object, entry: 'saved' | 'unsaved' | null): void => { if (entry) altEntries.set(terminal, entry); else altEntries.delete(terminal) }
export function trackAltEntry(terminal: { parser: { registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): unknown; registerEscHandler(id: { final: string }, callback: () => boolean): unknown }; buffer: { active: { type: string } } } & object): void {
  // Runs before xterm's own handler (it still runs: false): the buffer is the one being left.
  const record = (entering: boolean) => (params: (number | number[])[]) => {
    const alternate = terminal.buffer.active.type === 'alternate'
    for (const param of params) {
      if (param !== 1049 && param !== 47 && param !== 1047) continue
      // Entering from the normal screen (1049 saves the cursor there first); while alternate, nothing changes.
      if (entering && !alternate) { altEntries.set(terminal, param === 1049 ? 'saved' : 'unsaved'); break }
      if (!entering && alternate) { altEntries.delete(terminal); break }
    }
    return false
  }
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, record(true))
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, record(false))
  // RIS leaves the alternate screen without a DECRST.
  terminal.parser.registerEscHandler({ final: 'c' }, () => { altEntries.delete(terminal); return false })
}
