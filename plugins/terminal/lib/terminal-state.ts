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
import headless from '@xterm/headless'
import { applyTerminalProfile, TERMINAL_OPTIONS } from './terminal-profile'
import { altEnteredCols, HAS_EXTENDED } from './xterm-fixes'

export type Term = InstanceType<typeof headless.Terminal>

export interface Extended { _ext: number; underlineColor: number; urlId: number }
export interface Cell { getChars(): string; getWidth(): number; fg: number; bg: number; extended: Extended }
export interface Line { isWrapped: boolean; loadCell(x: number, cell: Cell): Cell }
/** A line's raw cells in the pinned version: three words per cell (content, fg, bg). */
export const lineWords = (line: Line): Uint32Array => (line as unknown as { _data: Uint32Array })._data
/** Content.IS_COMBINED_MASK in the pinned version (the characters live in a side map). */
export const IS_COMBINED = 0x200000
/** A fresh line's cell: no character, width 1, default attributes. */
export const BLANK_CONTENT = 1 << 22
/**
 * True when cell `x` of two lines has the same key for certain: equal words,
 * with no extended attributes or combined characters (which live in side
 * maps). False means unknown: compare the keys.
 */
export function sameWords(a: Uint32Array, b: Uint32Array, x: number): boolean {
  const i = x * 3
  const content = a[i]!
  const bg = a[i + 2]!
  return content === b[i] && a[i + 1] === b[i + 1] && bg === b[i + 2] && !(bg & HAS_EXTENDED) && !(content & IS_COMBINED)
}
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
    _parser: {
      currentState: number; _parseStack: { state: number }; precedingJoinState: number; _collect: number
      _params: { toArray(): unknown[]; _rejectDigits: boolean; _rejectSubDigits: boolean; _digitIsSub: boolean }
      _oscParser: { _state: number; _id: number; _active?: { _data?: string; _hitLimit?: boolean }[] }
      _dcsParser: { _ident: number; _active?: { _data?: string; _hitLimit?: boolean }[] }
    }
    _utf8Decoder: { interim: Uint8Array }
    _stringDecoder: { _interim: number }
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
export { HAS_EXTENDED }
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
 * Extended attributes: underline style and colour (compared whether or not
 * the underline bit is set: a DECRC can leave a style the renderer draws)
 * and the link.
 */
export function extendedKey(terminal: Term, fg: number, extended: Extended | null, links?: LinkNames): string {
  if (!extended) return ''
  let link = linkUri(terminal, extended.urlId)
  if (links && extended.urlId) {
    if (!links.has(extended.urlId)) links.set(extended.urlId, links.size)
    link = `#${links.get(extended.urlId)}:${link}`
  }
  return `${fg & UNDERLINE ? 'u' : '-'}${rawUnderlineStyle(extended)}:${extended.underlineColor}:${link}`
}

/** A cell's identity: content (empty is not a space, nor any character), width, attributes, link. */
export function cellKey(terminal: Term, cell: Cell, links?: LinkNames): string {
  const key = extendedKey(terminal, cell.fg, cell.bg & HAS_EXTENDED ? cell.extended : null, links)
  // Fields joined by a control character, which a printed cell can never hold; an empty cell has no content field at all.
  const chars = cell.getChars()
  return `${chars === '' ? '\u0003' : chars}\u0002${cell.getWidth()}\u0002${cell.fg | 0}\u0002${cell.bg & ~HAS_EXTENDED}\u0002${key}`
}
/** Cells of a row in a state: separated by a character no cell key contains. */
const CELLS = '\u0001'

// Charsets compare by identity: each designation xterm knows, named once from a terminal the caller builds.
const charsetNames: { code: string; map: unknown }[] = []
export const CHARSET_CODES = ['0', 'A', 'B', '4', 'C', '5', 'R', 'f', 'Q', '9', 'K', 'Y', 'E', '6', 'Z', 'H', '7', '=']
/** Learn xterm's charset maps (shared objects) once, from a scratch terminal built like every other. */
function learnCharsets(): void {
  if (charsetNames.length) return
  const scratch = new headless.Terminal({ cols: 2, rows: 1, ...TERMINAL_OPTIONS })
  applyTerminalProfile(scratch).setLive(false)
  const core = internals(scratch)
  for (const code of CHARSET_CODES) {
    core._writeBuffer.writeSync(`\x1b(${code}`)
    const map = core._charsetService._charsets[0]
    if (map && !charsetNames.some((known) => known.map === map)) charsetNames.push({ code, map })
  }
  scratch.dispose()
}
export function charsetName(map: unknown): string {
  if (!map) return 'US'
  learnCharsets()
  return charsetNames.find((known) => known.map === map)?.code ?? '?'
}

/** DECSC keeps an absolute buffer row: compared exactly. */
export const savedKey = (buffer: Buffer) => `${buffer.savedX},${buffer.savedY},${buffer.savedCurAttrData.fg},${buffer.savedCurAttrData.bg},${charsetName(buffer.savedCharset)}`
/**
 * Every tab stop, including stale ones past the width after a shrink: a
 * later widening shows them again, and bytes cannot set one past the width,
 * so a checkpoint with them is rejected rather than restored without them.
 */
export const tabStops = (tabs: Record<number, boolean | undefined>) => Object.keys(tabs).map(Number).filter((column) => tabs[column])
const stops = (tabs: Record<number, boolean | undefined>) => tabStops(tabs).join(',')

function rowsState(terminal: Term, buffer: Buffer, links: LinkNames): string[] {
  const rows: string[] = []
  const cell = nullCell(terminal)
  for (let y = 0; y < buffer.lines.length; y++) {
    const line = buffer.lines.get(y)!
    const cells: string[] = []
    for (let x = 0; x < terminal.cols; x++) cells.push(cellKey(terminal, line.loadCell(x, cell), links))
    rows.push((line.isWrapped ? 'W ' : '  ') + cells.join(CELLS))
  }
  return rows
}
const bufferFields = (buffer: Buffer) => ({ x: buffer.x, y: buffer.y, ybase: buffer.ybase, scroll: `${buffer.scrollTop}-${buffer.scrollBottom}`, saved: savedKey(buffer), tabs: stops(buffer.tabs) })

export function fullState(terminal: Term) {
  const core = internals(terminal)
  const alternate = terminal.buffer.active.type === 'alternate'
  // Links are named in this order: normal rows, alternate rows, then the pen.
  const links: LinkNames = new Map()
  const normalRows = rowsState(terminal, core.buffers.normal, links)
  const altRows = alternate ? rowsState(terminal, core.buffers.alt, links) : null
  const fields = stateFields(terminal, links)
  return {
    ...fields,
    normal: { rows: normalRows, ...fields.normal },
    alt: altRows && fields.alt ? { rows: altRows, ...fields.alt } : null,
  }
}

/** Everything in the full state but the rows; `links` holds the names the rows gave. */
function stateFields(terminal: Term, links: LinkNames) {
  const core = internals(terminal)
  const handler = core._inputHandler
  const parser = handler._parser
  const charsets = core._charsetService
  const pen = handler._curAttrData
  const alternate = terminal.buffer.active.type === 'alternate'
  const overrides = core.coreService.decPrivateModes
  return {
    type: terminal.buffer.active.type, cols: terminal.cols, rows: terminal.rows,
    normal: bufferFields(core.buffers.normal), alt: alternate ? bufferFields(core.buffers.alt) : null,
    modes: JSON.stringify(terminal.modes), cursorHidden: core.coreService.isCursorHidden,
    // DECSCUSR's override (unset after RIS or CSI 0 SP q), and blinking, which a program sets with DECSET 12;
    // the configured style is configuration, not state.
    cursorStyle: `${overrides.cursorStyle}/${overrides.cursorBlink}/blink:${core.optionsService.rawOptions.cursorBlink}`,
    mouseEncoding: core.coreMouseService?.activeEncoding,
    charsets: [charsets.glevel, charsetName(charsets.charset), ...[0, 1, 2, 3].map((g) => charsetName(charsets._charsets[g]))].join(','),
    // The pen, and the underline it remembers while underline is off (a later SGR 4 reuses the colour).
    // The pen's extended attributes are read whether or not its HAS_EXTENDED
    // bit is set: an open link survives SGR 0 there and the next print uses it.
    // With its HAS_EXTENDED bit: a link held while the bit is clear (after a
    // DECRC, say) is latent — not printed until an SGR sets the bit again.
    pen: `${pen.fg},${pen.bg & ~HAS_EXTENDED},ext:${pen.bg & HAS_EXTENDED ? 1 : 0},${extendedKey(terminal, pen.fg, pen.extended, links)},remembered:${rawUnderlineStyle(pen.extended)}:${pen.extended.underlineColor}`,
    // The inactive alternate buffer is cleared on every switch except its DECSC slot, which a later 1049h + ESC 8 reads.
    // Where the alternate screen was entered (the shared tab stops' rule on leaving it).
    altEntered: alternate ? String(altEnteredCols(terminal)) : '-',
    altSaved: alternate ? '-' : `${savedKey(core.buffers.alt)},lines:${core.buffers.alt.lines.length}/${core.buffers.alt.lines.maxLength},tabs:${stops(core.buffers.alt.tabs)}`,
    // Parser state that changes how the next bytes are read: the state, the
    // join state, mid-sequence params and intermediates, partial UTF-8 (in
    // xterm's decoder and held back by the profile), and the payload an
    // OSC or DCS string has collected so far.
    parser: `${parser.currentState},${parser._parseStack.state},${parser.precedingJoinState}`,
    // Params with their continuation flags (past 32 params, digits are rejected).
    sequence: parser.currentState ? `${JSON.stringify(parser._params.toArray())}:${parser._collect}:${+parser._params._rejectDigits}${+parser._params._rejectSubDigits}${+parser._params._digitIsSub}` : '-',
    // Partial characters: the UTF-8 bytes xterm's decoder holds; a lone surrogate from a string write.
    utf8: `${[...handler._utf8Decoder.interim].join('.')}+${handler._stringDecoder._interim}`,
    osc: parser._oscParser._state ? `${parser._oscParser._state}:${parser._oscParser._id}:${payloads(parser._oscParser._active)}` : '-',
    dcs: parser._dcsParser._active?.length ? `${parser._dcsParser._ident}:${payloads(parser._dcsParser._active)}` : '-',
  }
}
export type TerminalState = ReturnType<typeof fullState>
const payloads = (handlers: { _data?: string; _hitLimit?: boolean }[] | undefined) => JSON.stringify((handlers ?? []).map((handler) => [handler._data ?? '', Boolean(handler._hitLimit)]))

/** The first difference between two states, named by field (null when equal). */
export function stateDiff<State extends object>(a: State, b: State): string | null {
  for (const key of Object.keys(a) as (keyof State & string)[]) {
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

/**
 * Rows of two buffers, one row per step: the first difference (null when
 * equal). Keys are built only where words cannot decide; links are named in
 * the same order as `fullState`'s.
 */
function* rowsDiff(a: Term, b: Term, name: string, x: Buffer, y: Buffer, linksA: LinkNames, linksB: LinkNames): Generator<void, string | null> {
  if (x.lines.length !== y.lines.length) return `${name}.rows length ${x.lines.length} vs ${y.lines.length}`
  const cellA = nullCell(a)
  const cellB = nullCell(b)
  for (let row = 0; row < x.lines.length; row++) {
    const lineA = x.lines.get(row)!
    const lineB = y.lines.get(row)!
    const wordsA = lineWords(lineA)
    const wordsB = lineWords(lineB)
    for (let column = 0; column < a.cols; column++) {
      if (sameWords(wordsA, wordsB, column)) continue
      const keyA = cellKey(a, lineA.loadCell(column, cellA), linksA)
      const keyB = cellKey(b, lineB.loadCell(column, cellB), linksB)
      if (keyA !== keyB) return `${name} row ${row}/${x.lines.length}${lineA.isWrapped !== lineB.isWrapped ? ' wrap-flag' : ''} col ${column}: ${keyA} vs ${keyB}`
    }
    if (lineA.isWrapped !== lineB.isWrapped) return `${name} row ${row}/${x.lines.length} wrap-flag`
    yield
  }
  return null
}

/**
 * `stateDiff(fullState(a), fullState(b))`'s verdict, one row per step and
 * without building either state: what a checkpoint is verified with.
 */
export function* compareSteps(a: Term, b: Term): Generator<void, string | null> {
  if (a.buffer.active.type !== b.buffer.active.type) return `type ${a.buffer.active.type} vs ${b.buffer.active.type}`
  if (a.cols !== b.cols || a.rows !== b.rows) return `size ${a.cols}x${a.rows} vs ${b.cols}x${b.rows}`
  const linksA: LinkNames = new Map()
  const linksB: LinkNames = new Map()
  const coreA = internals(a)
  const coreB = internals(b)
  const normal = yield* rowsDiff(a, b, 'normal', coreA.buffers.normal, coreB.buffers.normal, linksA, linksB)
  if (normal) return normal
  if (a.buffer.active.type === 'alternate') {
    const alt = yield* rowsDiff(a, b, 'alt', coreA.buffers.alt, coreB.buffers.alt, linksA, linksB)
    if (alt) return alt
  }
  return stateDiff(stateFields(a, linksA), stateFields(b, linksB))
}

/** Run steps to the end, synchronously. */
export function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}
