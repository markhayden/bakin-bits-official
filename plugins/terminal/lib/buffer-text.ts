/**
 * A terminal buffer as plain text (Copy text, for selecting on a phone):
 * the history and the screen, a soft-wrapped row joined back into the line
 * it continues, trailing spaces and trailing blank rows dropped. Browser-safe
 * (the xterm buffer API, the same in the headless and browser packages).
 */

interface CellLike { getChars(): string; getWidth(): number }
interface LineLike {
  isWrapped: boolean
  length: number
  translateToString(trimRight?: boolean, start?: number, end?: number): string
  getCell(x: number): CellLike | undefined
}
interface BufferLike {
  length: number
  getLine(y: number): LineLike | undefined
}

export function bufferText(buffer: BufferLike): { text: string; lines: number } {
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    // A wrapped row continues the line above it: rows join untrimmed (a space at the wrap is real), the line is trimmed whole.
    // A wide character that did not fit leaves the row's last cell empty (no character was printed there): it is not a space.
    const next = buffer.getLine(y + 1)
    const padded = Boolean(next?.isWrapped && next.getCell(0)?.getWidth() === 2 && line.getCell(line.length - 1)?.getChars() === '')
    const row = line.translateToString(false, 0, padded ? line.length - 1 : line.length)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += row
    else lines.push(row)
  }
  // trimEnd is linear (a whitespace regex backtracks quadratically on a long run of spaces in V8).
  const trimmed = lines.map((line) => line.trimEnd())
  while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop()
  return { text: trimmed.join('\n'), lines: trimmed.length }
}
