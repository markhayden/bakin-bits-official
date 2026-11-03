/**
 * A width change (spec D13, plan T34a): tmux reflows its
 * history and cursor line and xterm does not, so the picture's geometry is
 * taken from tmux while everything else stays the live terminal's own.
 *
 * `installGeometry(target, source)`: `source` is a fresh profile terminal
 * built from a tmux seed at the log's ordered boundary (same size and line
 * capacity as `target` after its resize). Ownership:
 * - from tmux: both buffers' lines (history and screen, wrap flags,
 *   combined and extended cells; links remapped into the target's registry,
 *   with markers on the target's own buffers), the active cursor (a pending
 *   wrap too), region and the shared tab stops; the inactive normal cursor and its
 *   return slot only for an alternate screen entered by 1049 (the seed's
 *   `alternate_saved_x/y` is that return point);
 * - kept by the target: its parser and decoder (an unfinished sequence
 *   finishes), pen (an anonymous link it holds keeps its identity when one
 *   anonymous source link has its URI; otherwise the two are apart — a
 *   recorded limit), charsets, modes, cursor style, both saved-cursor slots
 *   (their row on the screen kept: `newSavedY = newYbase + (oldSavedY -
 *   oldYbase)`; it may fall above the history, which DECRC clamps), the
 *   inactive normal cursor for a 47/1047 entry;
 * - the viewport goes to the bottom (following output again), and the
 *   browser is told: rows refreshed, the cursor moved, the scroll area
 *   synced.
 *
 * One helper for the server's replica and every browser viewer (both
 * xterm packages share these 6.0.0 internals). False, with nothing
 * changed, when it cannot be done faithfully (size, line capacity or the
 * active screen disagree): the caller rebuilds instead.
 */
import { altEntry } from './xterm-fixes'

interface Extended { urlId: number; clone(): Extended }
interface Marker { line: number; onDispose(listener: () => void): unknown }
interface LinkEntry { id: number; key?: string; data: { id?: string; uri: string }; lines: Marker[] }
interface LinkService {
  _nextId: number
  _dataByLinkId: Map<number, LinkEntry>
  _entriesWithId: Map<string, LinkEntry>
  _removeMarkerFromLink(entry: LinkEntry, marker: Marker): void
  getLinkData(linkId: number): { id?: string; uri: string } | undefined
}
interface Line {
  _extendedAttrs: Record<number, Extended | undefined>
  _data: Uint32Array
  clone(): Line
}
interface Lines { length: number; maxLength: number; get(index: number): Line | undefined; push(line: Line): void; splice(start: number, deleteCount: number): void }
interface Buffer {
  lines: Lines
  x: number; y: number; ybase: number; ydisp: number
  scrollTop: number; scrollBottom: number
  savedX: number; savedY: number
  tabs: Record<number, boolean | undefined>
  addMarker(y: number): Marker
}
interface Core {
  buffers: { normal: Buffer; alt: Buffer; active: Buffer }
  _bufferService: { cols: number; rows: number; isUserScrolling: boolean; _onScroll?: { fire(ydisp: number): void } }
  _inputHandler: { _curAttrData: { bg: number; extended: Extended }; _onCursorMove?: { fire(): void } }
  _oscLinkService: LinkService
  refresh?(start: number, end: number): void
}

const HAS_EXTENDED = 0x10000000
const coreOf = (terminal: object): Core => (terminal as { _core: Core })._core
const linkedCells = function* (line: Line): Generator<[number, Extended]> {
  for (const [x, extended] of Object.entries(line._extendedAttrs)) {
    if (extended?.urlId && line._data[Number(x) * 3 + 2]! & HAS_EXTENDED) yield [Number(x), extended]
  }
}

/** The source's links as target entries: one map for the whole installation. */
class LinkMap {
  private ids = new Map<number, number>()
  private created = new Set<LinkEntry>()
  private penReuse: { uri: string; id: number } | undefined
  constructor(private target: Core, private source: Core) {
    // The pen's anonymous link keeps its identity if exactly one anonymous source link has its URI.
    const pen = target._inputHandler._curAttrData.extended
    const penData = pen.urlId ? target._oscLinkService.getLinkData(pen.urlId) : undefined
    if (penData && penData.id === undefined) {
      const matches = new Set<number>()
      for (const buffer of [source.buffers.normal, source.buffers.alt]) {
        for (let y = 0; y < buffer.lines.length; y++) {
          for (const [, extended] of linkedCells(buffer.lines.get(y)!)) {
            const data = source._oscLinkService.getLinkData(extended.urlId)
            if (data && data.id === undefined && data.uri === penData.uri) matches.add(extended.urlId)
          }
        }
      }
      if (matches.size === 1) this.penReuse = { uri: penData.uri, id: pen.urlId }
    }
  }
  map(sourceId: number): number {
    let mapped = this.ids.get(sourceId)
    if (mapped !== undefined) return mapped
    const data = this.source._oscLinkService.getLinkData(sourceId)
    mapped = data ? this.entryFor(data) : 0
    this.ids.set(sourceId, mapped)
    return mapped
  }
  private entryFor(data: { id?: string; uri: string }): number {
    const links = this.target._oscLinkService
    if (data.id !== undefined) {
      const key = `${data.id};;${data.uri}`
      const known = links._entriesWithId.get(key)
      if (known) return known.id
      const entry: LinkEntry = { id: links._nextId++, key, data: { id: data.id, uri: data.uri }, lines: [] }
      links._entriesWithId.set(key, entry)
      links._dataByLinkId.set(entry.id, entry)
      this.created.add(entry)
      return entry.id
    }
    if (this.penReuse?.uri === data.uri) return this.penReuse.id
    const entry: LinkEntry = { id: links._nextId++, data: { uri: data.uri }, lines: [] }
    links._dataByLinkId.set(entry.id, entry)
    this.created.add(entry)
    return entry.id
  }
  /** A marker on `buffer`'s line `y` for the link, so it lives while its cells are there (once per line). */
  mark(buffer: Buffer, y: number, id: number, marked: Set<string>): void {
    const links = this.target._oscLinkService
    const entry = links._dataByLinkId.get(id)
    const key = `${id}:${y}`
    if (!entry || marked.has(key)) return
    marked.add(key)
    const marker = buffer.addMarker(y)
    entry.lines.push(marker)
    marker.onDispose(() => links._removeMarkerFromLink(entry, marker))
  }
  /** An entry this installation made that got no marker is dropped (nothing would reclaim it). */
  dropUnmarked(): void {
    const links = this.target._oscLinkService
    for (const entry of this.created) {
      if (entry.lines.length) continue
      links._dataByLinkId.delete(entry.id)
      if (entry.key !== undefined) links._entriesWithId.delete(entry.key)
    }
  }
}

/** Copy `source`'s lines into `target` (same capacity), remapping link ids; markers on the target buffer itself. */
function replaceLines(targetBuffer: Buffer, sourceBuffer: Buffer, links: LinkMap): void {
  // Clearing the old lines drops their markers (link lifetimes follow, lib/xterm-fixes.ts patchLinkLifetime).
  targetBuffer.lines.splice(0, targetBuffer.lines.length)
  // Cells of one run share their attribute object: their copy is shared too.
  const copies = new Map<Extended, Extended>()
  const marked = new Set<string>()
  for (let y = 0; y < sourceBuffer.lines.length; y++) {
    const line = sourceBuffer.lines.get(y)!.clone()
    for (const [x, extended] of linkedCells(line)) {
      // A line's clone shares the source's attribute objects: the target gets copies carrying its own id.
      let copy = copies.get(extended)
      if (!copy) { copy = extended.clone(); copy.urlId = links.map(extended.urlId); copies.set(extended, copy) }
      line._extendedAttrs[x] = copy
    }
    targetBuffer.lines.push(line)
    for (const [, extended] of linkedCells(line)) if (extended.urlId) links.mark(targetBuffer, y, extended.urlId, marked)
  }
}

export function installGeometry(target: object, source: object): boolean {
  const to = coreOf(target)
  const from = coreOf(source)
  if (to._bufferService.cols !== from._bufferService.cols || to._bufferService.rows !== from._bufferService.rows) return false
  const alternate = to.buffers.active === to.buffers.alt
  if (alternate !== (from.buffers.active === from.buffers.alt)) return false
  // Pushing more lines than the target holds would trim them under coordinates taken from the source.
  for (const buffer of ['normal', 'alt'] as const) {
    if (from.buffers[buffer].lines.length > to.buffers[buffer].lines.maxLength) return false
  }
  const returnSlot = alternate && altEntry(target) === 'saved'
  // Saved slots move with the viewport: their row relative to the screen's top is kept.
  const saved = [to.buffers.normal, to.buffers.alt].map((buffer) => ({ buffer, x: buffer.savedX, row: buffer.savedY - buffer.ybase }))
  const normalCursor = { x: to.buffers.normal.x, y: to.buffers.normal.y }
  const links = new LinkMap(to, from)
  for (const buffer of ['normal', 'alt'] as const) {
    replaceLines(to.buffers[buffer], from.buffers[buffer], links)
    to.buffers[buffer].ybase = from.buffers[buffer].ybase
    to.buffers[buffer].ydisp = from.buffers[buffer].ybase
  }
  links.dropUnmarked()
  for (const { buffer, x, row } of saved) {
    buffer.savedX = x
    buffer.savedY = buffer.ybase + row
  }
  // The active screen's cursor, region and stops are tmux's.
  const active = to.buffers.active
  const sourceActive = from.buffers.active
  active.x = sourceActive.x
  active.y = sourceActive.y
  active.scrollTop = sourceActive.scrollTop
  active.scrollBottom = sourceActive.scrollBottom
  // Tab stops are shared by the two screens (the profile's patchSharedTabStops).
  for (const buffer of [to.buffers.normal, to.buffers.alt]) buffer.tabs = { ...sourceActive.tabs }
  if (alternate) {
    const normal = to.buffers.normal
    if (returnSlot) {
      // Entered by 1049: the normal cursor and its return slot are tmux's (the seed enters by 1049 too).
      normal.x = from.buffers.normal.x
      normal.y = from.buffers.normal.y
      normal.savedX = from.buffers.normal.savedX
      normal.savedY = from.buffers.normal.savedY
    } else {
      // 47/1047: tmux reports no normal cursor; the target's own stays (on the screen).
      normal.x = Math.min(normalCursor.x, to._bufferService.cols)
      normal.y = Math.min(normalCursor.y, to._bufferService.rows - 1)
    }
  }
  // Follow the output again, and tell the browser (a headless terminal has no renderer: these are no-ops).
  to._bufferService.isUserScrolling = false
  to._bufferService._onScroll?.fire(active.ydisp)
  to._inputHandler._onCursorMove?.fire()
  to.refresh?.(0, to._bufferService.rows - 1)
  return true
}
