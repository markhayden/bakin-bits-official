/**
 * ONE LCS diff walker for the plan views (#706) — line-diff and
 * block-diff both tokenize differently but share this table + backtrack.
 * O(n·m); callers bound their inputs.
 */
export type LcsOp<T> = { type: 'same' | 'added' | 'removed'; item: T }

export function lcsDiff<T>(a: readonly T[], b: readonly T[], equals: (x: T, y: T) => boolean = (x, y) => x === y): Array<LcsOp<T>> {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = equals(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: Array<LcsOp<T>> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (equals(a[i], b[j])) {
      out.push({ type: 'same', item: b[j] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'removed', item: a[i] })
      i++
    } else {
      out.push({ type: 'added', item: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ type: 'removed', item: a[i++] })
  while (j < b.length) out.push({ type: 'added', item: b[j++] })
  return out
}
