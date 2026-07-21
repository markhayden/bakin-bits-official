/**
 * Line-level diff for the plan history view (bakin#703). Tokenizes into
 * lines and rides the shared LCS walker (lib/lcs.ts).
 */
import { lcsDiff } from './lcs'

export interface DiffLine {
  type: 'same' | 'added' | 'removed'
  text: string
}

export function diffLines(before: string, after: string): DiffLine[] {
  // ''.split() yields [''] — an empty side must diff as zero lines, not one
  // spurious blank line.
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  return lcsDiff(a, b).map((op) => ({ type: op.type, text: op.item }))
}
