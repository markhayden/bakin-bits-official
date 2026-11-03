/** What Copy text shows of a terminal's text (the whole of it is what Copy all copies). */

/** At most this many lines, and characters, are shown (Copy all still copies everything). */
export const COPY_TEXT_SHOWN = 2_000
export const COPY_TEXT_SHOWN_CHARS = 400_000

export type Snapshot = { text: string; lines: number }
/** The newest lines within both budgets, and whether anything was left out. */
export function shownText(all: string): { text: string; cut: boolean } {
  const lines = all.split('\n')
  let text = lines.length > COPY_TEXT_SHOWN ? lines.slice(-COPY_TEXT_SHOWN).join('\n') : all
  if (text.length > COPY_TEXT_SHOWN_CHARS) {
    text = text.slice(-COPY_TEXT_SHOWN_CHARS)
    // Never start on half of a character outside the BMP (a low surrogate alone).
    const first = text.charCodeAt(0)
    if (first >= 0xdc00 && first <= 0xdfff) text = text.slice(1)
  }
  return { text, cut: text.length < all.length }
}
