/**
 * Block-level change marking for the rendered plan view (bakin#703).
 * Rendering destroys line identity, so the "what just changed" hint works
 * at markdown-block granularity: split on blank lines (fence-aware), LCS
 * over blocks against the previous snapshot. Added/edited blocks get a
 * green edge bar; pure deletions surface as an explicit red marker at the
 * removal site (they have no block of their own to mark).
 */

export type PlanDiffEntry =
  | { type: 'block'; text: string; changed: boolean }
  | { type: 'removed' }

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

/**
 * The current body's blocks plus removal markers, diffed against
 * `previous`. Added/edited blocks are `changed` (green bar); a removal
 * that is NOT part of an edit (no adjacent added block) becomes an
 * explicit `removed` marker at the spot the content used to be, so pure
 * deletions stay visible without implying the neighbors changed.
 */
export function diffBlocks(previous: string, current: string): PlanDiffEntry[] {
  const a = splitBlocks(previous)
  const b = splitBlocks(current)

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: PlanDiffEntry[] = []
  let i = 0
  let j = 0
  let pendingRemoval = false
  const flushRemoval = () => {
    if (pendingRemoval) out.push({ type: 'removed' })
    pendingRemoval = false
  }
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flushRemoval()
      out.push({ type: 'block', text: b[j], changed: false })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pendingRemoval = true
      i++
    } else {
      // An addition right after removals is an EDIT — green only, no marker.
      pendingRemoval = false
      out.push({ type: 'block', text: b[j], changed: true })
      j++
    }
  }
  if (i < a.length) pendingRemoval = true
  while (j < b.length) {
    pendingRemoval = false
    out.push({ type: 'block', text: b[j++], changed: true })
  }
  flushRemoval()
  return out
}
