import { describe, expect, it } from 'bun:test'
import { inputParts, PASTE_END, PASTE_START } from '../lib/paste'

describe('input with bracketed pastes', () => {
  it('splits complete pastes from the input around them, in order', () => {
    expect(inputParts('abc')).toEqual([{ paste: false, text: 'abc' }])
    expect(inputParts(`${PASTE_START}one\rtwo${PASTE_END}\r`)).toEqual([{ paste: true, text: 'one\rtwo' }, { paste: false, text: '\r' }])
    expect(inputParts(`x${PASTE_START}a${PASTE_END}y${PASTE_START}b${PASTE_END}`)).toEqual([
      { paste: false, text: 'x' }, { paste: true, text: 'a' }, { paste: false, text: 'y' }, { paste: true, text: 'b' },
    ])
  })
  it('keeps an empty paste (sent as nothing) and an unterminated start marker as plain input', () => {
    expect(inputParts(`${PASTE_START}${PASTE_END}`)).toEqual([{ paste: true, text: '' }])
    expect(inputParts(`a${PASTE_START}b`)).toEqual([{ paste: false, text: `a${PASTE_START}b` }])
    expect(inputParts(`${PASTE_END}x`)).toEqual([{ paste: false, text: `${PASTE_END}x` }])
  })
})
