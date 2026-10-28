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
