/**
 * The full state of an xterm 6.0.0 emulator (spec D13): every cell (an
 * empty cell is not a space), attributes, links, wrap flags, both buffers,
 * cursor, pending wrap, region, the DECSC slots, tab stops, charsets, the
 * current pen (with its remembered underline), modes, cursor style, mouse
 * encoding and the parser state that changes how the next bytes are read.
 * A checkpoint is accepted only when restoring it reproduces this exactly.
 *
 * Reads the pinned version's internals (checked by the xterm pin test).
 */
import type headless from '@xterm/headless'

export type Term = InstanceType<typeof headless.Terminal>

export interface Extended { _ext: number; underlineColor: number; urlId: number }
export interface Cell { getChars(): string; getWidth(): number; fg: number; bg: number; extended: Extended }
export interface Line { isWrapped: boolean; loadCell(x: number, cell: Cell): Cell }
export interface Buffer {
  lines: { length: number; maxLength: number; get(y: number): Line | undefined }
  x: number; y: number; ybase: number; scrollTop: number; scrollBottom: number
  savedX: number; savedY: number; savedCurAttrData: { fg: number; bg: number }; savedCharset: unknown
  tabs: Record<number, boolean | undefined>
}
export interface Internals {
  buffers: { normal: Buffer; alt: Buffer; active: Buffer }
  _inputHandler: {
    _curAttrData: { fg: number; bg: number; extended: Extended }
    _parser: { currentState: number; _parseStack: { state: number }; precedingJoinState: number; _collect: number; _oscParser: { _state: number }; _dcsParser: { _active?: unknown[] } }
    _utf8Decoder: { interim: Uint8Array }
  }
  _charsetService: { glevel: number; charset: unknown; _charsets: unknown[] }
  coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } }
  optionsService: { rawOptions: { cursorStyle: string; cursorBlink: boolean; scrollback: number } }
  coreMouseService?: { activeEncoding: string }
  _oscLinkService: { getLinkData(id: number): { uri: string; id?: string } | undefined }
  _writeBuffer: { writeSync(data: string | Uint8Array): void }
}
export const internals = (terminal: Term): Internals => (terminal as unknown as { _core: Internals })._core
export const nullCell = (terminal: Term): Cell => terminal.buffer.normal.getNullCell() as unknown as Cell

/** BgFlags.HAS_EXTENDED and FgFlags.UNDERLINE in the pinned version. */
export const HAS_EXTENDED = 0x10000000
export const UNDERLINE = 0x10000000
/** ExtendedAttrs.underlineStyle reports 5 (dashed) while a link is active, whatever is stored: read the raw bits. */
export const rawUnderlineStyle = (extended: Extended) => (extended._ext & 0x1c000000) >> 26

export const linkUri = (terminal: Term, id: number) => id ? internals(terminal)._oscLinkService.getLinkData(id)?.uri ?? '(dangling)' : ''
/**
 * Links compare by grouping, not by number (ids differ between terminals):
 * each link is named by the order it first appears in, plus its URI. With
 * no naming, a link compares by URI only (the serializer's own use).
 */
export type LinkNames = Map<number, number>
/**
 * Underline style and colour are cell state only while underline is set
 * (xterm sets the style whenever underline is turned on, so one left behind
 * with underline off is never read again).
 */
export function extendedKey(terminal: Term, fg: number, extended: Extended | null, links?: LinkNames): string {
  if (!extended) return ''
  let link = linkUri(terminal, extended.urlId)
  if (links && extended.urlId) {
    if (!links.has(extended.urlId)) links.set(extended.urlId, links.size)
    link = `#${links.get(extended.urlId)}:${link}`
  }
  return `${fg & UNDERLINE ? `${rawUnderlineStyle(extended)}:${extended.underlineColor}` : '-'}:${link}`
}

/** A cell's identity: content (empty is not a space, nor any character), width, attributes, link. */
export function cellKey(terminal: Term, cell: Cell, links?: LinkNames): string {
  const key = extendedKey(terminal, cell.fg, cell.bg & HAS_EXTENDED ? cell.extended : null, links)
  return JSON.stringify([cell.getChars() === '' ? null : cell.getChars(), cell.getWidth(), cell.fg | 0, cell.bg & ~HAS_EXTENDED, key])
}
/** Cells of a row in a state: separated by a character no cell key contains. */
const CELLS = '\u0001'

// Charsets compare by identity: each designation xterm knows, named once from a terminal the caller builds.
const charsetNames: { code: string; map: unknown }[] = []
export const CHARSET_CODES = ['0', 'A', 'B', '4', 'C', '5', 'R', 'f', 'Q', '9', 'K', 'Y', 'E', '6', 'Z', 'H', '7', '=']
/** Learn xterm's charset maps from `scratch` (a profiled terminal), once. */
export function learnCharsets(scratch: Term): void {
  if (charsetNames.length) return
  const core = internals(scratch)
  for (const code of CHARSET_CODES) {
    core._writeBuffer.writeSync(`\x1b(${code}`)
    const map = core._charsetService._charsets[0]
    if (map && !charsetNames.some((known) => known.map === map)) charsetNames.push({ code, map })
  }
  core._writeBuffer.writeSync('\x1b(B')
}
export function charsetName(map: unknown): string {
  if (!map) return 'US'
  return charsetNames.find((known) => known.map === map)?.code ?? '?'
}

/** DECSC keeps an absolute buffer row: compared exactly. */
export const savedKey = (buffer: Buffer) => `${buffer.savedX},${buffer.savedY},${buffer.savedCurAttrData.fg},${buffer.savedCurAttrData.bg},${charsetName(buffer.savedCharset)}`
const stops = (tabs: Record<number, boolean | undefined>) => Object.keys(tabs).filter((column) => tabs[Number(column)]).join(',')

function bufferState(terminal: Term, buffer: Buffer, links: LinkNames) {
  const rows: string[] = []
  const cell = nullCell(terminal)
  for (let y = 0; y < buffer.lines.length; y++) {
    const line = buffer.lines.get(y)!
    const cells: string[] = []
    for (let x = 0; x < terminal.cols; x++) cells.push(cellKey(terminal, line.loadCell(x, cell), links))
    rows.push((line.isWrapped ? 'W ' : '  ') + cells.join(CELLS))
  }
  return { rows, x: buffer.x, y: buffer.y, ybase: buffer.ybase, scroll: `${buffer.scrollTop}-${buffer.scrollBottom}`, saved: savedKey(buffer), tabs: stops(buffer.tabs) }
}

export function fullState(terminal: Term) {
  const core = internals(terminal)
  const handler = core._inputHandler
  const parser = handler._parser
  const charsets = core._charsetService
  const pen = handler._curAttrData
  const penExtended = pen.bg & HAS_EXTENDED ? pen.extended : null
  const alternate = terminal.buffer.active.type === 'alternate'
  const links: LinkNames = new Map()
  const normal = bufferState(terminal, core.buffers.normal, links)
  const alt = alternate ? bufferState(terminal, core.buffers.alt, links) : null
  const overrides = core.coreService.decPrivateModes
  return {
    type: terminal.buffer.active.type, cols: terminal.cols, rows: terminal.rows,
    normal, alt,
    modes: JSON.stringify(terminal.modes), cursorHidden: core.coreService.isCursorHidden,
    // DECSCUSR's override (unset after RIS or CSI 0 SP q); the configured style is configuration, not state.
    cursorStyle: `${overrides.cursorStyle}/${overrides.cursorBlink}`,
    mouseEncoding: core.coreMouseService?.activeEncoding,
    charsets: [charsets.glevel, charsetName(charsets.charset), ...[0, 1, 2, 3].map((g) => charsetName(charsets._charsets[g]))].join(','),
    // The pen, and the underline it remembers while underline is off (a later SGR 4 reuses the colour).
    pen: `${pen.fg},${pen.bg & ~HAS_EXTENDED},${extendedKey(terminal, pen.fg, penExtended, links)},remembered:${rawUnderlineStyle(pen.extended)}:${pen.extended.underlineColor}`,
    // The inactive alternate buffer is cleared on every switch except its DECSC slot, which a later 1049h + ESC 8 reads.
    altSaved: alternate ? '-' : `${savedKey(core.buffers.alt)},lines:${core.buffers.alt.lines.length}/${core.buffers.alt.lines.maxLength},tabs:${stops(core.buffers.alt.tabs)}`,
    // Parser state that changes how the next bytes are read (collect only matters mid-sequence).
    parser: `${parser.currentState},${parser._parseStack.state},${parser.precedingJoinState},${parser.currentState ? parser._collect : '-'},${[...handler._utf8Decoder.interim].join('.')},${parser._oscParser._state},${parser._dcsParser._active?.length ?? 0}`,
  }
}
export type TerminalState = ReturnType<typeof fullState>

/** The first difference between two states, named by field (null when equal). */
export function stateDiff(a: TerminalState, b: TerminalState): string | null {
  for (const key of Object.keys(a) as (keyof TerminalState)[]) {
    const x = a[key] as unknown
    const y = b[key] as unknown
    if (x && typeof x === 'object' && y && typeof y === 'object') {
      const xs = x as Record<string, unknown>
      const ys = y as Record<string, unknown>
      for (const field of Object.keys(xs)) {
        if (field === 'rows') {
          const rx = xs.rows as string[]
          const ry = ys.rows as string[]
          if (rx.length !== ry.length) return `${key}.rows length ${rx.length} vs ${ry.length}`
          for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) {
            const cx = rx[i]!.slice(2).split(CELLS)
            const cy = ry[i]!.slice(2).split(CELLS)
            const column = cx.findIndex((value, n) => value !== cy[n])
            return `${key} row ${i}/${rx.length}${rx[i]![0] !== ry[i]![0] ? ' wrap-flag' : ''} col ${column}: ${cx[column]} vs ${cy[column]}`
          }
        } else if (String(xs[field]) !== String(ys[field])) return `${key}.${field} ${xs[field]} vs ${ys[field]}`
      }
    } else if (String(x) !== String(y)) return `${key} ${x} vs ${y}`
  }
  return null
}
