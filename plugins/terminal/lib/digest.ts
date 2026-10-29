/**
 * The digest a raw-path viewer and the server's replica compare at the same
 * `{epoch, seq}` (spec D13 digest safety net, plan T37): the visible screen
 * (every cell's characters, width and attributes, and each row's wrap), the
 * cursor, the active buffer and the modes that change what input or output
 * does. Browser-safe: only xterm's public buffer API, shared by the headless
 * replica and the browser terminal (both pinned to one release). Detection,
 * not a guarantee: the replica and its viewers share one layout.
 */

/** The xterm surface the digest reads (both packages' `Terminal`). */
export interface DigestTerminal {
  rows: number
  cols: number
  buffer: { active: { type: string; baseY: number; cursorX: number; cursorY: number; getLine(y: number): DigestLine | undefined; getNullCell(): DigestCell } }
  modes: Record<string, unknown>
}
interface DigestLine { isWrapped: boolean; getCell(x: number, cell: DigestCell): DigestCell | undefined }
interface DigestCell {
  getChars(): string; getWidth(): number
  getFgColorMode(): number; getFgColor(): number; getBgColorMode(): number; getBgColor(): number
  isBold(): number; isItalic(): number; isDim(): number; isUnderline(): number; isBlink(): number
  isInverse(): number; isInvisible(): number; isStrikethrough(): number; isOverline(): number
}

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

export function screenDigest(terminal: DigestTerminal): string {
  const buffer = terminal.buffer.active
  let hash = fnv(0x811c9dc5, `${terminal.cols}x${terminal.rows} ${buffer.type} ${buffer.cursorX},${buffer.cursorY}`)
  hash = fnv(hash, MODES.map((mode) => `${mode}=${String(terminal.modes[mode])}`).join(' '))
  const cell = buffer.getNullCell()
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)
    if (!line) { hash = fnv(hash, '\n-'); continue }
    hash = fnv(hash, line.isWrapped ? '\nw' : '\n')
    for (let x = 0; x < terminal.cols; x++) {
      line.getCell(x, cell)
      hash = fnv(hash, `${cell.getChars()}\u0000${cell.getWidth()}${cell.getFgColorMode()}.${cell.getFgColor()}.${cell.getBgColorMode()}.${cell.getBgColor()}.`
        + `${cell.isBold()}${cell.isItalic()}${cell.isDim()}${cell.isUnderline()}${cell.isBlink()}${cell.isInverse()}${cell.isInvisible()}${cell.isStrikethrough()}${cell.isOverline()}`)
    }
  }
  return hash.toString(16).padStart(8, '0')
}
