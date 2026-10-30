/**
 * The digest a viewer and the server's replica compare at the same
 * `{epoch, seq}` (spec D13 digest safety net, plan T37): the visible screen
 * (every cell's characters, width and attributes, and each row's wrap), the
 * cursor (position, visibility, style), the active buffer, mouse reporting
 * and the modes that change what input or output does. Browser-safe: xterm's
 * buffer API plus a few pinned internals, identical in the headless replica
 * and the browser terminal (one release). Detection, not a guarantee: the
 * replica and its viewers share one layout.
 */

import type { IBufferCell, Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'

/**
 * Program-controlled state the public API does not expose, read from the
 * pinned 6.0.0 internals (identical in both packages; the architecture test
 * pins the release): cursor visibility and DECSCUSR style, mouse reporting.
 * Renderer-only state (blink phase, focus, theme, the viewer's configured
 * cursor style) is never read.
 */
interface Internals {
  coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } }
  coreMouseService: { activeProtocol: string; activeEncoding: string }
}
/** A cell's extended attributes, when it has them (underline style and colour; never a link's id, which differs per terminal). */
interface ExtendedCell { hasExtendedAttrs(): number; extended: { underlineStyle: number; underlineColor: number } }

const extendedOf = (cell: ExtendedCell) => cell.hasExtendedAttrs() ? `u${cell.extended.underlineStyle}.${cell.extended.underlineColor}` : ''

/** Modes that change what the program sees or how output lands (named in xterm's public `modes`). */
const MODES = [
  'applicationCursorKeysMode', 'applicationKeypadMode', 'bracketedPasteMode', 'insertMode', 'mouseTrackingMode',
  'originMode', 'reverseWraparoundMode', 'sendFocusMode', 'wraparoundMode',
] as const

/** FNV-1a, 32 bits, over UTF-16 code units: equal input, equal digest, in any JavaScript engine. */
function fnv(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function screenDigest(of: HeadlessTerminal | BrowserTerminal): string {
  // One implementation in both packages (6.0.0): read through the headless types.
  const terminal = of as HeadlessTerminal
  const buffer = terminal.buffer.active
  const core = (terminal as unknown as { _core: Internals })._core
  let hash = fnv(0x811c9dc5, `${terminal.cols}x${terminal.rows} ${buffer.type} ${buffer.cursorX},${buffer.cursorY}`)
  hash = fnv(hash, MODES.map((mode) => `${mode}=${String(terminal.modes[mode])}`).join(' '))
  const { decPrivateModes, isCursorHidden } = core.coreService
  hash = fnv(hash, `cursor ${isCursorHidden ? 'hidden' : 'shown'} ${decPrivateModes.cursorStyle ?? '-'} ${decPrivateModes.cursorBlink ?? '-'} mouse ${core.coreMouseService.activeProtocol} ${core.coreMouseService.activeEncoding}`)
  const cell: IBufferCell = buffer.getNullCell()
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)
    if (!line) { hash = fnv(hash, '\n-'); continue }
    hash = fnv(hash, line.isWrapped ? '\nw' : '\n')
    for (let x = 0; x < terminal.cols; x++) {
      line.getCell(x, cell)
      hash = fnv(hash, `${cell.getChars()}\u0000${cell.getWidth()}${cell.getFgColorMode()}.${cell.getFgColor()}.${cell.getBgColorMode()}.${cell.getBgColor()}.`
        + `${cell.isBold()}${cell.isItalic()}${cell.isDim()}${cell.isUnderline()}${cell.isBlink()}${cell.isInverse()}${cell.isInvisible()}${cell.isStrikethrough()}${cell.isOverline()}`
        + extendedOf(cell as unknown as ExtendedCell))
    }
  }
  return hash.toString(16).padStart(8, '0')
}
