/**
 * Bakin's checkpoint serializer (spec D13, plan T32a): bytes that rebuild an
 * emulator's full state in a fresh one of the same size and scrollback —
 * not SerializeAddon, which drops wrap flags, empty cells, the DECSC slots,
 * the inactive alternate buffer, charsets and more.
 *
 * A checkpoint is taken only when the parser is between sequences, and is
 * accepted only when restoring it into a scratch terminal reproduces the
 * full state (lib/terminal-state.ts). The grapheme join state (what the
 * next combining character joins) cannot be rebuilt from bytes — any escape
 * clears it — so it travels beside them and is set after they are parsed.
 *
 * Reads the pinned version's internals (checked by the xterm pin test).
 */
import headless from '@xterm/headless'
import { applyTerminalProfile, TERMINAL_OPTIONS } from './terminal-profile'
import { carriedUtf8 } from './xterm-fixes'
import {
  cellKey, charsetName, fullState, HAS_EXTENDED, internals, learnCharsets, nullCell, rawUnderlineStyle, savedKey, stateDiff,
  type Buffer, type Extended, type Term,
} from './terminal-state'

/** Bumped whenever the bytes or fields change meaning. */
export const CHECKPOINT_FORMAT = 1

export interface Checkpoint {
  format: typeof CHECKPOINT_FORMAT
  cols: number
  rows: number
  scrollback: number
  /** The serialized terminal. */
  data: string
  /** The parser's grapheme join state after `data` (xterm's packed character properties; 0 for none). */
  joinState: number
}

/** A terminal built the way every emulator is (the profile), live effects off. */
function scratch(cols: number, rows: number, scrollback: number): Term {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS, scrollback })
  applyTerminalProfile(terminal).setLive(false)
  return terminal
}
let defaultBlank = ''
let defaultSlot = ''
function learn(): void {
  if (defaultBlank) return
  const terminal = scratch(2, 1, 0)
  learnCharsets(terminal)
  const core = internals(terminal)
  defaultBlank = cellKey(terminal, core.buffers.normal.lines.get(0)!.loadCell(0, nullCell(terminal)))
  defaultSlot = savedKey(core.buffers.normal)
  terminal.dispose()
}

/** SGR for a cell's (or the pen's) attributes, from the default. */
export function sgr(fg: number, bg: number, extended: Extended | null): string {
  const params: (number | string)[] = [0]
  const has = (value: number, bit: number) => (value & bit) !== 0
  if (has(fg, 0x8000000)) params.push(1)
  if (has(bg, 0x8000000)) params.push(2)
  if (has(bg, 0x4000000)) params.push(3)
  if (has(fg, 0x10000000)) params.push(extended && rawUnderlineStyle(extended) > 1 ? `4:${rawUnderlineStyle(extended)}` : 4)
  if (has(fg, 0x20000000)) params.push(5)
  if (has(fg, 0x4000000)) params.push(7)
  if (has(fg, 0x40000000)) params.push(8)
  if (has(fg, 0x80000000)) params.push(9)
  if (has(bg, 0x40000000)) params.push(53)
  const colour = (value: number, base: number, bright: number, extendedCode: number) => {
    const mode = value & 0x3000000
    const index = value & 0xffffff
    if (mode === 0x1000000) params.push(index < 8 ? base + index : bright + index - 8)
    else if (mode === 0x2000000) params.push(`${extendedCode};5;${index}`)
    else if (mode === 0x3000000) params.push(`${extendedCode};2;${(index >> 16) & 255};${(index >> 8) & 255};${index & 255}`)
  }
  colour(fg, 30, 90, 38)
  colour(bg, 40, 100, 48)
  if (extended && extended.underlineColor !== -1 && extended.underlineColor) {
    const value = extended.underlineColor
    const mode = value & 0x3000000
    const index = value & 0xffffff
    if (mode === 0x2000000 || mode === 0x1000000) params.push(`58;5;${index}`)
    else if (mode === 0x3000000) params.push(`58;2;${(index >> 16) & 255};${(index >> 8) & 255};${index & 255}`)
  }
  return `\x1b[${params.join(';')}m`
}

const osc8 = (uri: string, id = '') => `\x1b]8;${id ? 'id=' + id : ''};${uri}\x1b\\`
/**
 * A link is one registry entry kept alive by every line it was printed on:
 * each segment reopens it under one id. A link the program gave no id gets
 * one with this checkpoint's nonce, so it cannot merge with a program's id.
 */
let nonce = ''
function linkParams(terminal: Term, urlId: number): { uri: string; id: string } {
  const data = internals(terminal)._oscLinkService.getLinkData(urlId)
  return { uri: data?.uri ?? '(dangling)', id: data?.id ?? `bakin.${nonce}.${urlId}` }
}
/** DECSCA's protection (BgFlags.PROTECTED): not part of SGR, so a reset leaves it. */
const PROTECTED = 0x20000000
const protection = (on: boolean) => on ? '\x1b[1"q' : '\x1b[0"q'

/**
 * Lines [from, end) of `buffer`, printed from the cursor; wrapped lines wrap
 * naturally. Empty cells stay empty: default ones are skipped with CUF,
 * coloured ones (erased with a background) are made with ECH. The DECSC slot
 * (an absolute row) is saved while its row is the cursor row.
 */
function printLines(terminal: Term, buffer: Buffer, from: number, slotLine = -1): string {
  const cell = nullCell(terminal)
  let out = ''
  let link = ''
  let protectedNow = false
  const protect = (on: boolean) => { if (on !== protectedNow) { out += protection(on); protectedNow = on } }
  for (let y = from; y < buffer.lines.length; y++) {
    const line = buffer.lines.get(y)!
    let slotDue = y === slotLine
    if (slotDue && !line.isWrapped) { out += savedSlot(terminal, buffer) + '\r'; slotDue = false }
    const next = y + 1 < buffer.lines.length ? buffer.lines.get(y + 1)! : null
    const full = Boolean(next?.isWrapped)
    let end = 0
    for (let x = 0; x < terminal.cols; x++) if (cellKey(terminal, line.loadCell(x, cell)) !== defaultBlank) end = x + 1
    let pen = ''
    let x = 0
    while (x < end) {
      line.loadCell(x, cell)
      if (cell.getWidth() === 0) { x++; continue }
      if (cell.getChars() === '') {
        // A run of empty cells with the same attributes.
        const key = cellKey(terminal, cell)
        let run = 1
        while (x + run < end && cellKey(terminal, line.loadCell(x + run, cell)) === key) run++
        line.loadCell(x, cell)
        if (link) { out += osc8(''); link = '' }
        if (key !== defaultBlank) {
          const attributes = sgr(cell.fg, cell.bg & ~HAS_EXTENDED, null)
          // SGR 0 clears protection in the pinned version: protection after it.
          out += attributes
          protectedNow = false
          protect((cell.bg & PROTECTED) !== 0)
          out += `\x1b[${run}X`
          pen = attributes
        }
        if (x + run < terminal.cols) out += `\x1b[${run}C`
        // Up to the last column: the next line's wide character wraps from here.
        else if (full) out += `\x1b[${terminal.cols}G`
        x += run
        continue
      }
      const extended = cell.bg & HAS_EXTENDED ? cell.extended : null
      const params = extended && extended.urlId ? linkParams(terminal, extended.urlId) : null
      const key = params ? `${params.id}\u0000${params.uri}` : ''
      if (key !== link) { out += params ? osc8(params.uri, params.id) : osc8(''); link = key }
      const attributes = sgr(cell.fg, cell.bg & ~HAS_EXTENDED, extended)
      if (attributes !== pen) { out += attributes; pen = attributes; protectedNow = false }
      protect((cell.bg & PROTECTED) !== 0)
      out += cell.getChars()
      x += cell.getWidth()
      if (slotDue) {
        if (link) { out += osc8(''); link = '' }
        out += savedSlot(terminal, buffer) + `\x1b[${x + 1}G`
        pen = ''
        protectedNow = false
        slotDue = false
      }
    }
    if (!full) {
      if (link) { out += osc8(''); link = '' }
      if (pen && pen !== '\x1b[0m') { out += '\x1b[0m'; protectedNow = false }
      if (next) out += '\r\n'
    }
  }
  if (link) out += osc8('')
  protect(false)
  return out + '\x1b[0m'
}

const DESIGNATORS = ['(', ')', '*', '+']
const charsetCode = (map: unknown) => charsetName(map) === 'US' ? 'B' : charsetName(map)
/** The DECSC slot: charset via G0 at level 0, position, attributes, then ESC 7. */
function savedSlot(terminal: Term, buffer: Buffer, y?: number): string {
  // The slot keeps bg's HAS_EXTENDED bit raw (DECRC then attaches the current
  // extended attributes): an open placeholder link sets that bit without
  // changing fg/bg, so ESC 7 saves it exactly.
  const extended = buffer.savedCurAttrData.bg & HAS_EXTENDED
  const column = Math.min(buffer.savedX, terminal.cols - 1) + 1
  const protectedSlot = (buffer.savedCurAttrData.bg & PROTECTED) !== 0
  return `\x1b(${charsetCode(buffer.savedCharset)}\x0f` + (y === undefined ? `\x1b[${column}G` : `\x1b[${y + 1};${column}H`)
    + sgr(buffer.savedCurAttrData.fg, buffer.savedCurAttrData.bg & ~HAS_EXTENDED, null) + (protectedSlot ? protection(true) : '')
    + (extended ? osc8('https://bakin.invalid/checkpoint') : '') + '\x1b7' + (extended ? osc8('') : '') + '\x1b[0m' + (protectedSlot ? protection(false) : '') + '\x1b(B'
}
function bufferTail(terminal: Term, buffer: Buffer, slot: boolean): string {
  let out = '\x1b[3g' + Object.keys(buffer.tabs).filter((column) => buffer.tabs[Number(column)]).map((column) => `\x1b[1;${Number(column) + 1}H\x1bH`).join('')
  if (slot) out += savedSlot(terminal, buffer, buffer.savedY - buffer.ybase)
  return out + `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`
}
function charsetTail(terminal: Term): string {
  const charsets = internals(terminal)._charsetService
  return [0, 1, 2, 3].map((g) => `\x1b${DESIGNATORS[g]}${charsetCode(charsets._charsets[g])}`).join('') + ['\x0f', '\x0e', '\x1bn', '\x1bo'][charsets.glevel]
}

/** Serialize `terminal` (no check: see `takeCheckpoint`). */
export function serialize(terminal: Term): string {
  learn()
  nonce = Math.random().toString(36).slice(2, 10)
  const core = internals(terminal)
  const normal = core.buffers.normal
  const alt = core.buffers.alt
  const alternate = terminal.buffer.active.type === 'alternate'
  const active = alternate ? alt : normal
  let out = '\x1bc'
  // A first line that wraps from a line already scrolled away: a filler it wraps from.
  if (normal.lines.get(0)?.isWrapped) out += '\x1b[0m' + 'x'.repeat(terminal.cols)
  out += printLines(terminal, normal, 0, savedKey(normal) === defaultSlot ? -1 : normal.savedY)
  // The inactive alternate buffer's DECSC slot: 47h (switch without saving or clearing), the slot, 47l.
  if (!alternate && (alt.lines.length === 0 || savedKey(alt) !== defaultSlot)) out += '\x1b[?47h' + savedSlot(terminal, alt, alt.savedY) + '\x1b[?47l'
  if (alternate) {
    // The normal buffer's slot is in place; enter the alternate screen without saving (47h, not 1049h).
    out += bufferTail(terminal, normal, false) + '\x1b(B\x0f\x1b[?47h\x1b[0m\x1b[H'
    out += printLines(terminal, alt, 0)
  }
  out += bufferTail(terminal, active, alternate)
  out += charsetTail(terminal)
  const charsets = core._charsetService
  if (charsetName(charsets.charset) !== charsetName(charsets._charsets[charsets.glevel]) && charsets.charset === active.savedCharset) out += '\x1b8'
  // The cursor; a pending wrap at the right margin reprints the last cell so x == cols.
  if (active.x >= terminal.cols) {
    const line = active.lines.get(active.ybase + active.y)!
    const cell = nullCell(terminal)
    let x = terminal.cols - 1
    if (line.loadCell(x, cell).getWidth() === 0) x--
    line.loadCell(x, cell)
    const extended = cell.bg & HAS_EXTENDED ? cell.extended : null
    // The same link as the rest of its cells: reopened under its id.
    const link = extended && extended.urlId ? linkParams(terminal, extended.urlId) : null
    out += `\x1b[${active.y + 1};${x + 1}H` + (link ? osc8(link.uri, link.id) : '') + sgr(cell.fg, cell.bg & ~HAS_EXTENDED, extended) + (cell.getChars() || ' ') + (link ? osc8('') : '')
  } else out += `\x1b[${active.y + 1};${active.x + 1}H`
  const pen = core._inputHandler._curAttrData
  // The pen always carries its extended attributes (an underline colour is remembered while underline is off).
  out += sgr(pen.fg, pen.bg & ~HAS_EXTENDED, pen.extended)
  if (pen.bg & PROTECTED) out += protection(true)
  const modes = terminal.modes as typeof terminal.modes & { synchronizedOutputMode?: boolean }
  if (modes.applicationCursorKeysMode) out += '\x1b[?1h'
  if (modes.applicationKeypadMode) out += '\x1b='
  if (modes.bracketedPasteMode) out += '\x1b[?2004h'
  if (modes.insertMode) out += '\x1b[4h'
  if (modes.reverseWraparoundMode) out += '\x1b[?45h'
  if (modes.sendFocusMode) out += '\x1b[?1004h'
  if (modes.synchronizedOutputMode) out += '\x1b[?2026h'
  if (modes.wraparoundMode === false) out += '\x1b[?7l'
  const mouse: Record<string, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 }
  if (modes.mouseTrackingMode !== 'none') out += `\x1b[?${mouse[modes.mouseTrackingMode]}h`
  const encoding = core.coreMouseService?.activeEncoding
  if (encoding === 'SGR') out += '\x1b[?1006h'
  else if (encoding === 'SGR_PIXELS') out += '\x1b[?1016h'
  else if (encoding === 'URXVT') out += '\x1b[?1015h'
  else if (encoding === 'UTF8') out += '\x1b[?1005h'
  if (core.coreService.isCursorHidden) out += '\x1b[?25l'
  // Blinking is an option a program can set (DECSET 12): always written.
  out += core.optionsService.rawOptions.cursorBlink ? '\x1b[?12h' : '\x1b[?12l'
  // DECSCUSR's override (the configured style is configuration, not state; RIS leaves no override).
  const override = core.coreService.decPrivateModes
  if (override.cursorStyle !== undefined) out += `\x1b[${({ block: 1, underline: 3, bar: 5 } as Record<string, number>)[override.cursorStyle]! + (override.cursorBlink ? 0 : 1)} q`
  if (modes.originMode) out += `\x1b[?6h\x1b[${active.y - active.scrollTop + 1};${active.x + 1}H`
  // An open hyperlink in the pen: the same link its printed cells carry, so it continues under its id.
  const penExtended = pen.bg & HAS_EXTENDED ? pen.extended : null
  if (penExtended && penExtended.urlId) {
    const link = linkParams(terminal, penExtended.urlId)
    out += osc8(link.uri, link.id)
  }
  return out
}

/**
 * Between sequences, with no partial UTF-8 (in xterm's decoder or held back
 * by the profile): a point where bytes can rebuild the parser exactly.
 */
export function quiescent(terminal: Term): boolean {
  const handler = internals(terminal)._inputHandler
  const parser = handler._parser
  return parser.currentState === 0 && parser._parseStack.state === 0 && handler._utf8Decoder.interim[0] === 0 && carriedUtf8(terminal) === 0
}

/** Rebuild `terminal` (fresh: same size and scrollback) from `checkpoint`, synchronously. */
export function restoreCheckpointSync(terminal: Term, checkpoint: Checkpoint): void {
  internals(terminal)._writeBuffer.writeSync(checkpoint.data)
  internals(terminal)._inputHandler._parser.precedingJoinState = checkpoint.joinState
}
/** Rebuild `terminal` from `checkpoint` through its write queue: bytes written after it parse after the join state is set. */
export function restoreCheckpoint(terminal: Term, checkpoint: Checkpoint): Promise<void> {
  return new Promise<void>((resolve) => terminal.write(checkpoint.data, () => {
    internals(terminal)._inputHandler._parser.precedingJoinState = checkpoint.joinState
    resolve()
  }))
}

/**
 * A checkpoint of `terminal` now, or why there is none: the parser is
 * mid-sequence, or restoring the bytes into a scratch terminal does not
 * reproduce the full state.
 */
export function takeCheckpoint(terminal: Term): { checkpoint: Checkpoint } | { rejected: string } {
  if (!quiescent(terminal)) return { rejected: 'parser not quiescent' }
  const scrollback = internals(terminal).optionsService.rawOptions.scrollback
  const checkpoint: Checkpoint = {
    format: CHECKPOINT_FORMAT, cols: terminal.cols, rows: terminal.rows, scrollback,
    data: serialize(terminal), joinState: internals(terminal)._inputHandler._parser.precedingJoinState,
  }
  const restored = scratch(terminal.cols, terminal.rows, scrollback)
  try {
    restoreCheckpointSync(restored, checkpoint)
    const difference = stateDiff(fullState(terminal), fullState(restored))
    return difference ? { rejected: difference } : { checkpoint }
  } finally {
    restored.dispose()
  }
}
