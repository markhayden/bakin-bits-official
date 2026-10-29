import { describe, expect, it } from 'bun:test'
import { offerCaption, offerPreview } from '../components/terminal-canvas'

describe('a clipboard offer, said plainly', () => {
  it('previews its first line with text, never a blank one', () => {
    expect(offerPreview('\n\n  first words  \nsecond')).toBe('first words')
    expect(offerPreview('one line')).toBe('one line')
    expect(offerPreview('\n \n')).toBe('(blank)')
  })
  it('says what it is, and how many lines', () => {
    expect(offerCaption('one line')).toBe('Text to copy')
    expect(offerCaption('a\nb\nc')).toBe('Text to copy · 3 lines')
  })
})
