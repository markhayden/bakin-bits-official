import { describe, expect, it } from 'bun:test'
import { PASTE_END, PASTE_START, stripPasteMarkers } from '../lib/paste'

describe('paste text', () => {
  it('loses every bracketed-paste marker, so tmux brackets it and the text cannot end the paste early', () => {
    expect(stripPasteMarkers(`${PASTE_START}one\rtwo${PASTE_END}`)).toBe('one\rtwo')
    expect(stripPasteMarkers(`x${PASTE_END}; rm -rf ~`)).toBe('x; rm -rf ~')
    // A marker rebuilt from the pieces of removed ones goes too.
    expect(stripPasteMarkers(`\x1b[20${PASTE_END}1~evil`)).toBe('evil')
    expect(stripPasteMarkers('plain \x1b[1mbold')).toBe('plain \x1b[1mbold')
  })
})
