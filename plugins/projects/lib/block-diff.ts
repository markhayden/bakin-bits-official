/**
 * Block-level change marking for the rendered plan view (bakin#703).
 * Rendering destroys line identity, so the "what just changed" hint works
 * at markdown-block granularity: split on blank lines (fence-aware), LCS
 * over blocks against the previous snapshot. Added/edited blocks get a
 * green edge bar; pure deletions surface as an explicit red marker at the
 * removal site (they have no block of their own to mark).
 */

import { lcsDiff } from './lcs'

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
 * `previous` via the shared LCS walker. Added/edited blocks are `changed`
 * (green bar); a removal that is NOT part of an edit (no adjacent added
 * block) becomes an explicit `removed` marker at the removal site, so
 * pure deletions stay visible without implying the neighbors changed.
 */
export function diffBlocks(previous: string, current: string): PlanDiffEntry[] {
  const ops = lcsDiff(splitBlocks(previous), splitBlocks(current))
  const out: PlanDiffEntry[] = []
  let pendingRemoval = false
  for (const op of ops) {
    if (op.type === 'same') {
      if (pendingRemoval) out.push({ type: 'removed' })
      pendingRemoval = false
      out.push({ type: 'block', text: op.item, changed: false })
    } else if (op.type === 'removed') {
      pendingRemoval = true
    } else {
      // An addition right after removals is an EDIT — green only, no marker.
      pendingRemoval = false
      out.push({ type: 'block', text: op.item, changed: true })
    }
  }
  if (pendingRemoval) out.push({ type: 'removed' })
  return out
}
