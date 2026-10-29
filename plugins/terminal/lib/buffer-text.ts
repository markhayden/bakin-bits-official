/**
 * A terminal buffer as plain text (Copy text, for selecting on a phone):
 * the history and the screen, a soft-wrapped row joined back into the line
 * it continues, trailing spaces and trailing blank rows dropped. Browser-safe
 * (the xterm buffer API, the same in the headless and browser packages).
 */

interface BufferLike {
  length: number
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

export function bufferText(buffer: BufferLike): { text: string; lines: number } {
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    // A wrapped row continues the line above it: rows join untrimmed (a space at the wrap is real), the line is trimmed whole.
    const row = line.translateToString(false)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += row
    else lines.push(row)
  }
  const trimmed = lines.map((line) => line.replace(/\s+$/, ''))
  while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop()
  return { text: trimmed.join('\n'), lines: trimmed.length }
}
