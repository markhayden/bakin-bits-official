/** Browser-only regression assertion for the real SDK plan fixture. */
export function assertPlanSpacing(root: HTMLElement): void {
  for (const label of ['Latest changes', 'Changes hidden', 'No history']) {
    const region = root.querySelector<HTMLElement>(`section[aria-label="${label}"]`)
    if (!region) throw new Error(`Missing plan fixture: ${label}`)
    const blocks = [...region.querySelectorAll<HTMLElement>('h1, h2, p, ul')]
    if (blocks.length !== 5) throw new Error(`${label}: expected five rendered Markdown blocks, got ${blocks.length}`)

    // Measure visible content, not component names/classes. A 320px editor
    // canvas around even one heading must fail at both fixture widths.
    const bounds = region.getBoundingClientRect()
    let previousBottom = bounds.top
    for (const block of blocks) {
      const rect = block.getBoundingClientRect()
      const gap = rect.top - previousBottom
      if (rect.height <= 0 || gap < -1 || gap > 64) {
        throw new Error(`${label}: ${block.tagName} has ${Math.round(gap)}px preceding gap (expected 0–64px) and ${Math.round(rect.height)}px height`)
      }
      previousBottom = rect.bottom
    }
    const trailingGap = bounds.bottom - previousBottom
    if (trailingGap > 64) throw new Error(`${label}: ${Math.round(trailingGap)}px unused space after the final block (maximum 64px)`)
  }
}
