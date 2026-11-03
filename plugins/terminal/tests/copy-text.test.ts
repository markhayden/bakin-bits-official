import { describe, expect, it } from 'bun:test'
import { COPY_TEXT_SHOWN, COPY_TEXT_SHOWN_CHARS, shownText } from '../lib/copy-text'

describe('shownText (Copy text)', () => {
  it('shows everything within both budgets', () => {
    expect(shownText('a\nb')).toEqual({ text: 'a\nb', cut: false })
  })
  it('keeps the newest lines, and the newest characters of an oversized line', () => {
    const many = Array.from({ length: COPY_TEXT_SHOWN + 10 }, (_, n) => `l${n}`).join('\n')
    const shown = shownText(many)
    expect(shown.cut).toBe(true)
    expect(shown.text.split('\n')).toHaveLength(COPY_TEXT_SHOWN)
    expect(shown.text.endsWith(`l${COPY_TEXT_SHOWN + 9}`)).toBe(true)
    const long = shownText('y'.repeat(COPY_TEXT_SHOWN_CHARS + 5))
    expect(long.text).toHaveLength(COPY_TEXT_SHOWN_CHARS)
  })
  it('never starts on half an emoji', () => {
    const text = shownText('😀' + 'x'.repeat(COPY_TEXT_SHOWN_CHARS - 1)).text
    const first = text.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
  })
})
