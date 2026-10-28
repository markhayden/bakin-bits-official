/**
 * A width change on the raw path (spec D13, plan T34a): tmux reflows its
 * history and cursor line and xterm does not, so the picture's geometry is
 * taken from tmux while everything else stays the live terminal's own.
 *
 * `installGeometry(target, source)`: `source` is a fresh profile terminal
 * built from a tmux seed at the log's ordered boundary (same size as
 * `target` after its resize). Its lines — history and screen, wrap flags,
 * combined characters and extended attributes, links remapped into the
 * target's own registry — replace the target's; its active cursor (a
 * pending wrap too), scroll region and tab stops become the target's. The
 * target keeps its parser and decoder (an unfinished sequence stays
 * unfinished), pen, charsets, modes, cursor style and both saved-cursor
 * slots (translated: `newSavedY = newYbase + (oldSavedY - oldYbase)`).
 *
 * One helper for the server's replica and every browser viewer (both
 * xterm packages share these 6.0.0 internals). False when it cannot be
 * done faithfully (the two disagree on size or on which screen is active):
 * the caller rebuilds instead.
 */

import { altEntry } from './xterm-fixes'

interface Extended { urlId: number; clone(): Extended }
interface LinkEntry { id: number; key?: string; data: { id?: string; uri: string }; lines: { line: number }[] }
interface LinkService {
  _nextId: number
  _dataByLinkId: Map<number, LinkEntry>
  _entriesWithId: Map<string, LinkEntry>
  addLineToLink(linkId: number, y: number): void
  getLinkData(linkId: number): { id?: string; uri: string } | undefined
}
interface Line {
  isWrapped: boolean
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
}
interface Core {
  buffers: { normal: Buffer; alt: Buffer; active: Buffer }
  _bufferService: { cols: number; rows: number; buffer: Buffer }
  _oscLinkService: LinkService
}

const HAS_EXTENDED = 0x10000000
const coreOf = (terminal: object): Core => (terminal as { _core: Core })._core

/** Copy `source`'s lines into `target` (same size), remapping link ids; markers follow the new lines. */
function replaceLines(target: Core, targetBuffer: Buffer, source: Core, sourceBuffer: Buffer): void {
  // Clearing the old lines drops their markers (link lifetimes follow, lib/xterm-fixes.ts patchLinkLifetime).
  targetBuffer.lines.splice(0, targetBuffer.lines.length)
  const remap = new Map<number, number>()
  // Cells of one run share their attribute object: their copy is shared too.
  const copies = new Map<Extended, Extended>()
  const links = target._oscLinkService
  for (let y = 0; y < sourceBuffer.lines.length; y++) {
    const line = sourceBuffer.lines.get(y)!.clone()
    for (const [x, extended] of Object.entries(line._extendedAttrs)) {
      const urlId = extended?.urlId
      if (!urlId || !(line._data[Number(x) * 3 + 2]! & HAS_EXTENDED)) continue
      let mapped = remap.get(urlId)
      if (mapped === undefined) {
        const data = source._oscLinkService.getLinkData(urlId)
        mapped = data ? linkFor(links, data) : 0
        remap.set(urlId, mapped)
      }
      // A line's clone shares the source's attribute objects: the target gets copies carrying its own id.
      let copy = copies.get(extended!)
      if (!copy) { copy = extended!.clone(); copy.urlId = mapped; copies.set(extended!, copy) }
      line._extendedAttrs[Number(x)] = copy
    }
    targetBuffer.lines.push(line)
  }
  // A marker for each line a link's cells are on, so the link lives while they are shown.
  for (let y = 0; y < targetBuffer.lines.length; y++) {
    const line = targetBuffer.lines.get(y)!
    const seen = new Set<number>()
    for (const [x, extended] of Object.entries(line._extendedAttrs)) {
      const urlId = extended?.urlId
      if (urlId && !seen.has(urlId) && line._data[Number(x) * 3 + 2]! & HAS_EXTENDED) { seen.add(urlId); links.addLineToLink(urlId, y) }
    }
  }
}

/** The target's entry for a link: the same one for an id'd link already known, else a new one (no marker yet). */
function linkFor(links: LinkService, data: { id?: string; uri: string }): number {
  if (data.id !== undefined) {
    const key = `${data.id};;${data.uri}`
    const known = links._entriesWithId.get(key)
    if (known) return known.id
    const entry: LinkEntry = { id: links._nextId++, key, data: { id: data.id, uri: data.uri }, lines: [] }
    links._entriesWithId.set(key, entry)
    links._dataByLinkId.set(entry.id, entry)
    return entry.id
  }
  const entry: LinkEntry = { id: links._nextId++, data: { uri: data.uri }, lines: [] }
  links._dataByLinkId.set(entry.id, entry)
  return entry.id
}

export function installGeometry(target: object, source: object): boolean {
  const to = coreOf(target)
  const from = coreOf(source)
  if (to._bufferService.cols !== from._bufferService.cols || to._bufferService.rows !== from._bufferService.rows) return false
  const alternate = to.buffers.active === to.buffers.alt
  if (alternate !== (from.buffers.active === from.buffers.alt)) return false
  // Saved slots move with the viewport: their row relative to the screen's top is kept.
  const saved = [to.buffers.normal, to.buffers.alt].map((buffer) => ({ buffer, x: buffer.savedX, row: buffer.savedY - buffer.ybase }))
  for (const [buffer, sourceBuffer] of [[to.buffers.normal, from.buffers.normal], [to.buffers.alt, from.buffers.alt]] as const) {
    replaceLines(to, buffer, from, sourceBuffer)
    buffer.ybase = sourceBuffer.ybase
    buffer.ydisp = sourceBuffer.ybase
  }
  for (const { buffer, x, row } of saved) {
    buffer.savedX = x
    buffer.savedY = buffer.ybase + row
  }
  // The active screen's cursor, region and stops are tmux's; the inactive one keeps its cursor row on the screen.
  const active = to.buffers.active
  const sourceActive = from.buffers.active
  active.x = sourceActive.x
  active.y = sourceActive.y
  active.scrollTop = sourceActive.scrollTop
  active.scrollBottom = sourceActive.scrollBottom
  active.tabs = { ...sourceActive.tabs }
  if (alternate) {
    const normal = to.buffers.normal
    normal.x = from.buffers.normal.x
    normal.y = from.buffers.normal.y
    // Entered by 1049, the normal screen's slot is the return point tmux reflowed (the seed enters by 1049 too).
    if (altEntry(target) === 'saved') { normal.savedX = from.buffers.normal.savedX; normal.savedY = from.buffers.normal.savedY }
  }
  return true
}
