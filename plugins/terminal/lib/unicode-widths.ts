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

/** tmux's width for a codepoint where it differs from the grapheme provider; undefined elsewhere. */
export function tmuxWidth(codepoint: number, table: readonly (readonly [number, number, 0 | 1 | 2])[] = TMUX_WIDTHS): 0 | 1 | 2 | undefined {
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

/** The grapheme provider with tmux's widths applied, active on `terminal`. */
export function applyTmuxWidths(terminal: UnicodeHost, table: readonly (readonly [number, number, 0 | 1 | 2])[] = TMUX_WIDTHS): void {
  terminal.unicode.register(tmuxWidthProvider(loadGraphemeProvider(terminal), table))
  terminal.unicode.activeVersion = TMUX_WIDTHS_VERSION
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
function textBytes(text: string): number {
  let bytes = 0
  for (const char of text) bytes += utf8Length(char.codePointAt(0)!)
  return bytes
}
interface CellLine { _data: Uint32Array; _combined: Record<number, string>; addCodepointToCell(index: number, codepoint: number, width: number): void }
const limited = new WeakSet<object>()
const CONTENT_MASK = 0x1fffff
const IS_COMBINED = 0x200000

/**
 * A cell keeps at most TMUX_CELL_BYTES of UTF-8, as tmux 3.7c does: the
 * combining marks or joined characters past it are dropped (a cell stays a
 * cell tmux would redraw alike, and no one cell grows without bound).
 * xterm appends to a cell in `BufferLine.addCodepointToCell` alone; its
 * prototype is shared by every terminal of that xterm module, patched once.
 */
export function applyTmuxCellLimit(terminal: object): void {
  const line = (terminal as { _core?: { buffers?: { normal?: { lines?: { get(index: number): object | undefined } } } } })._core?.buffers?.normal?.lines?.get(0)
  const prototype = line && Object.getPrototypeOf(line) as CellLine | undefined
  if (!prototype || limited.has(prototype) || typeof prototype.addCodepointToCell !== 'function') return
  limited.add(prototype)
  const add = prototype.addCodepointToCell
  prototype.addCodepointToCell = function (this: CellLine, index, codepoint, width) {
    const content = this._data[index * 3]!
    const current = content & IS_COMBINED ? textBytes(this._combined[index] ?? '') : content & CONTENT_MASK ? utf8Length(content & CONTENT_MASK) : 0
    if (current + utf8Length(codepoint) > TMUX_CELL_BYTES) return
    add.call(this, index, codepoint, width)
  }
}
