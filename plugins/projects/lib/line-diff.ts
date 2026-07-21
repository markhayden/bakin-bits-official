/**
 * Line-level diff for the plan history view (bakin#703). Classic LCS over
 * lines — plan bodies are small (spec docs), so the O(n·m) table is fine
 * and keeps this dependency-free.
 */

export interface DiffLine {
  type: 'same' | 'added' | 'removed'
  text: string
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  // lcs[i][j] = LCS length of a[i..] vs b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] })
      i++
    } else {
      out.push({ type: 'added', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++] })
  while (j < b.length) out.push({ type: 'added', text: b[j++] })
  return out
}
