/**
 * Block-level change marking for the rendered plan view (bakin#703).
 * Rendering destroys line identity, so the subtle "what just changed"
 * hint works at markdown-block granularity: split on blank lines
 * (fence-aware), LCS over blocks against the previous snapshot, and mark
 * the current blocks the last edit touched. Pure deletions have no block
 * of their own — the next surviving block carries the mark so the reader
 * still knows where to look.
 */

export interface PlanBlock {
  text: string
  changed: boolean
}

/** Split markdown into blank-line-separated blocks; code fences stay intact. */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence
    if (!inFence && line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

/** The current body's blocks, marked where they differ from `previous`. */
export function markChangedBlocks(previous: string, current: string): PlanBlock[] {
  const a = splitBlocks(previous)
  const b = splitBlocks(current)

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: PlanBlock[] = []
  let i = 0
  let j = 0
  let pendingRemoval = false
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ text: b[j], changed: pendingRemoval })
      pendingRemoval = false
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pendingRemoval = true // deletion: the next surviving block carries the mark
      i++
    } else {
      out.push({ text: b[j], changed: true })
      pendingRemoval = false
      j++
    }
  }
  while (j < b.length) {
    out.push({ text: b[j++], changed: true })
    pendingRemoval = false
  }
  while (i < a.length) {
    pendingRemoval = true
    i++
  }
  // Trailing deletion: mark the last surviving block.
  if (pendingRemoval && out.length > 0) out[out.length - 1].changed = true
  return out
}
