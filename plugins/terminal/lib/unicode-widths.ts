import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { TMUX_WIDTHS } from './tmux-width-table'

/** The xterm Unicode provider contract (both @xterm/xterm and @xterm/headless). */
export interface UnicodeProvider {
  readonly version: string
  wcwidth(codepoint: number): 0 | 1 | 2
  charProperties(codepoint: number, preceding: number): number
}
interface UnicodeHost {
  loadAddon(addon: { activate(terminal: never): void; dispose(): void }): void
  unicode: { activeVersion: string; register(provider: UnicodeProvider): void }
}

export const TMUX_WIDTHS_VERSION = '15-graphemes-tmux'

/**
 * Test-only table entries (plan T37: an injected width difference the
 * replica-against-tmux check must catch). Empty in production, where
 * nothing writes it.
 */
export const TEST_WIDTH_ENTRIES = new Map<number, 0 | 1 | 2>()

/** tmux's width for a codepoint where it differs from the grapheme provider; undefined elsewhere. */
export function tmuxWidth(codepoint: number, table: readonly (readonly [number, number, 0 | 1 | 2])[] = TMUX_WIDTHS): 0 | 1 | 2 | undefined {
  if (TEST_WIDTH_ENTRIES.size) { const forced = TEST_WIDTH_ENTRIES.get(codepoint); if (forced !== undefined) return forced }
  let low = 0
  let high = table.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [first, last, width] = table[middle]!
    if (codepoint < first) high = middle - 1
    else if (codepoint > last) low = middle + 1
    else return width
  }
  return undefined
}

// xterm 6.0.0 packs a character's properties as state << 3 | width << 1 | shouldJoin.
const widthOf = (properties: number) => (properties >> 1) & 3

/**
 * The grapheme provider, corrected to tmux 3.7c's scalar widths for the
 * codepoints in the table. A zero-width one (tmux puts it in the previous
 * cell) joins the preceding cell at that cell's width, since xterm gives
 * every non-joining character a cell of its own. Any other one takes tmux's
 * width unless the grapheme rules join it into a cluster. What tmux
 * combines by context is not mirrored (spec D13, the width-parity test).
 */
export function tmuxWidthProvider(base: UnicodeProvider, table: readonly (readonly [number, number, 0 | 1 | 2])[] = TMUX_WIDTHS): UnicodeProvider {
  return {
    version: TMUX_WIDTHS_VERSION,
    wcwidth: (codepoint) => tmuxWidth(codepoint, table) ?? base.wcwidth(codepoint),
    charProperties(codepoint, preceding) {
      const properties = base.charProperties(codepoint, preceding)
      const width = tmuxWidth(codepoint, table)
      if (width === undefined) return properties
      if (width === 0) {
        // Nothing to join at the start of a line.
        if (preceding === 0) return properties
        // Joined, at the preceding cell's width.
        return (properties & ~7) | (widthOf(preceding) << 1) | 1
      }
      // A cluster the grapheme rules join keeps their width.
      if (properties & 1) return properties
      return (properties & ~6) | (width << 1)
    },
  }
}

/** Load the grapheme addon on `terminal` and return its grapheme provider. */
export function loadGraphemeProvider(terminal: UnicodeHost): UnicodeProvider {
  const addon = new UnicodeGraphemesAddon()
  terminal.loadAddon(addon as unknown as { activate(terminal: never): void; dispose(): void })
  // The addon (pinned exactly) keeps its provider private; without it the widths would silently differ.
  const base = (addon as unknown as { _provider15Graphemes?: UnicodeProvider })._provider15Graphemes
  if (!base || typeof base.charProperties !== 'function') throw new Error('@xterm/addon-unicode-graphemes changed: its grapheme provider is not available')
  return base
}

/** The profile's provider without a terminal (for measuring text), built once. */
let measuring: UnicodeProvider | undefined
export function profileWidths(): UnicodeProvider {
  if (measuring) return measuring
  // The addon only registers its providers on the host it activates on.
  const host: UnicodeHost = {
    loadAddon: (addon) => addon.activate(host as never),
    unicode: { activeVersion: '', register: () => undefined },
  }
  measuring = tmuxWidthProvider(loadGraphemeProvider(host))
  return measuring
}

/**
 * The grapheme provider with tmux's widths applied, active on `terminal`,
 * and tmux's cell limit: a cell keeps at most TMUX_CELL_BYTES of UTF-8, the
 * combining marks or joined characters past it dropped, as tmux 3.7c does
 * (a cell stays one tmux redraws alike, and none grows without bound).
 */
export function applyTmuxWidths(terminal: UnicodeHost & object, table: readonly (readonly [number, number, 0 | 1 | 2])[] = TMUX_WIDTHS): void {
  terminal.unicode.register(cellLimited(tmuxWidthProvider(loadGraphemeProvider(terminal), table), terminal))
  terminal.unicode.activeVersion = TMUX_WIDTHS_VERSION
  limitCellText(terminal)
}

/**
 * The cells `text` (printable characters only: no escapes, tabs or
 * controls) takes as xterm prints it with the profile's widths: graphemes
 * joined, tmux's widths applied.
 */
export function textWidth(text: string, provider: UnicodeProvider): number {
  let width = 0
  let preceding = 0
  for (const char of text) {
    const properties = provider.charProperties(char.codePointAt(0)!, preceding)
    const cells = (properties >> 1) & 3
    // A joined character widens its cluster to its own width (xterm's print).
    width += properties & 1 ? Math.max(0, cells - ((preceding >> 1) & 3)) : cells
    preceding = properties
  }
  return width
}

/** The most UTF-8 a tmux 3.7c cell keeps (its grid data): a code point that would pass it is dropped. */
export const TMUX_CELL_BYTES = 32

const utf8Length = (codepoint: number): number => codepoint < 0x80 ? 1 : codepoint < 0x800 ? 2 : codepoint < 0x10000 ? 3 : 4
interface CellLine { _data: Uint32Array; _combined: Record<number, string>; getWidth(index: number): number; addCodepointToCell(index: number, codepoint: number, width: number): void }
interface ActiveBuffer { x: number; y: number; ybase: number; lines: { get(index: number): CellLine | undefined } }
const CONTENT_MASK = 0x1fffff
const IS_COMBINED = 0x200000
const WIDTH_SHIFT = 22
const WIDTH_MASK = 0x3 << WIDTH_SHIFT

function cellBytes(line: CellLine, index: number): number {
  const content = line._data[index * 3]!
  if (!(content & IS_COMBINED)) return content & CONTENT_MASK ? utf8Length(content & CONTENT_MASK) : 0
  let bytes = 0
  for (const char of line._combined[index] ?? '') bytes += utf8Length(char.codePointAt(0)!)
  return bytes
}
/** The bytes of the cell a joining code point would join (xterm's print: the cell before the cursor, or before its continuation). */
function joiningCellBytes(terminal: object): number | undefined {
  const buffer = (terminal as { _core?: { buffers?: { active?: ActiveBuffer } } })._core?.buffers?.active
  if (!buffer || buffer.x === 0) return undefined
  const line = buffer.lines.get(buffer.ybase + buffer.y)
  if (!line) return undefined
  const index = line.getWidth(buffer.x - 1) ? buffer.x - 1 : buffer.x - 2
  return index >= 0 ? cellBytes(line, index) : undefined
}

/**
 * A code point that would join a cell already holding TMUX_CELL_BYTES (with
 * it) is dropped by tmux 3.7c, so while the terminal prints it joins at the
 * cluster's width (VS16 does not widen a full cell): xterm then lays out no
 * wider cell, and the line prototype drops its text. Measuring text outside
 * print (xterm's getStringCellWidth, the WebGL atlas) never looks at the
 * cursor's cell.
 */
function cellLimited(provider: UnicodeProvider, terminal: object): UnicodeProvider {
  let printing = false
  const handler = (terminal as { _core?: { _inputHandler?: { print?(data: Uint32Array, start: number, end: number): void } } })._core?._inputHandler
  const print = handler?.print
  // The parser calls `this.print`, so an own property takes every print.
  if (handler && print) {
    handler.print = function (data, start, end) {
      printing = true
      try { print.call(this, data, start, end) } finally { printing = false }
    }
  }
  return {
    version: provider.version,
    wcwidth: (codepoint) => provider.wcwidth(codepoint),
    charProperties(codepoint, preceding) {
      const properties = provider.charProperties(codepoint, preceding)
      if (!printing || !(properties & 1)) return properties
      const bytes = joiningCellBytes(terminal)
      if (bytes === undefined || bytes + utf8Length(codepoint) <= TMUX_CELL_BYTES) return properties
      return (properties & ~6) | (widthOf(preceding) << 1)
    },
  }
}

const limited = new WeakSet<object>()
/**
 * xterm appends to a cell in `BufferLine.addCodepointToCell` alone. Its
 * prototype is shared by every terminal of that xterm module, patched once:
 * past TMUX_CELL_BYTES the text is dropped, and only a width change xterm
 * already laid out is kept (none, behind the provider above).
 */
function limitCellText(terminal: object): void {
  const line = (terminal as { _core?: { buffers?: { normal?: { lines?: { get(index: number): object | undefined } } } } })._core?.buffers?.normal?.lines?.get(0)
  const prototype = line && Object.getPrototypeOf(line) as CellLine | undefined
  if (!prototype || limited.has(prototype) || typeof prototype.addCodepointToCell !== 'function') return
  limited.add(prototype)
  const add = prototype.addCodepointToCell
  prototype.addCodepointToCell = function (this: CellLine, index, codepoint, width) {
    if (cellBytes(this, index) + utf8Length(codepoint) <= TMUX_CELL_BYTES) { add.call(this, index, codepoint, width); return }
    if (width) this._data[index * 3] = (this._data[index * 3]! & ~WIDTH_MASK) | (width << WIDTH_SHIFT)
  }
}
