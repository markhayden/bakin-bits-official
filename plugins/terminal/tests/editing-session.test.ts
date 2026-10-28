import { describe, expect, it } from 'bun:test'
import { enterHidesKeyboard, lineTail, nextSession, type SessionEvent } from '../components/editing-session'

const run = (events: SessionEvent[]) => events.reduce(nextSession, 'idle' as const as ReturnType<typeof nextSession>)

describe('the phone editing session', () => {
  it('starts typing when the terminal input takes focus and stays typing while the keys are used', () => {
    expect(run(['focus-input'])).toBe('typing')
    expect(run(['focus-input', 'focus-keys'])).toBe('typing')
  })
  it('ends when the keyboard is dismissed by the system or the hide key', () => {
    expect(run(['focus-input', 'focus-lost'])).toBe('idle')
    expect(run(['focus-input', 'hide'])).toBe('idle')
    expect(run(['focus-input', 'focus-outside'])).toBe('idle')
  })
  it('keeps the sheet open while the input loses focus to make room for it', () => {
    expect(run(['focus-input', 'open-sheet', 'focus-lost'])).toBe('sheet')
    expect(run(['focus-input', 'open-sheet', 'focus-keys'])).toBe('sheet')
  })
  it('leaves the sheet for typing (abc or tapping the terminal) or for idle (hide, focus elsewhere)', () => {
    expect(run(['focus-input', 'open-sheet', 'abc'])).toBe('typing')
    expect(run(['focus-input', 'open-sheet', 'focus-input'])).toBe('typing')
    expect(run(['focus-input', 'open-sheet', 'hide'])).toBe('idle')
    expect(run(['focus-input', 'open-sheet', 'focus-outside'])).toBe('idle')
  })
  it('ignores key focus and focus loss while idle', () => {
    expect(run(['focus-keys'])).toBe('idle')
    expect(run(['focus-lost'])).toBe('idle')
  })
})

describe('Enter puts the on-screen keyboard away', () => {
  const enter = { key: 'Enter', code: '', keyCode: 13, isComposing: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
  const send = { continued: false, modified: false }
  it('for an on-screen keyboard: no physical key code, or a visibly covered screen', () => {
    expect(enterHidesKeyboard(enter, undefined, send)).toBe(true)
    expect(enterHidesKeyboard({ ...enter, code: 'Enter' }, 300, send)).toBe(true)
  })
  it('not for a hardware keyboard (a physical key code and an uncovered screen)', () => {
    expect(enterHidesKeyboard({ ...enter, code: 'Enter' }, 0, send)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, code: 'NumpadEnter' }, 55, send)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, code: 'Enter' }, undefined, send)).toBe(false)
  })
  it('not for other keys, an IME confirming its text, or a modified Enter', () => {
    expect(enterHidesKeyboard({ ...enter, key: 'a' }, 300, send)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, isComposing: true }, 300, send)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, shiftKey: true }, 300, send)).toBe(false)
  })
  it('not for a Return that continues the line, or an IME key (229)', () => {
    expect(enterHidesKeyboard(enter, 300, { continued: true, modified: false })).toBe(false)
    expect(enterHidesKeyboard(enter, 300, { continued: false, modified: true })).toBe(false)
    expect(enterHidesKeyboard({ ...enter, keyCode: 229 }, 300, send)).toBe(false)
  })
})

describe('the line tail (for `\\` + Return continuation)', () => {
  it('is the last character typed or pasted, ignoring paste markers and replies', () => {
    expect(lineTail('', 'echo a\\')).toBe('\\')
    expect(lineTail('a', '\x1b[200~line\\\x1b[201~')).toBe('\\')
    // A cursor-position reply leaves it as it was; an arrow or Delete makes it unknown.
    expect(lineTail('\\', '\x1b[12;3R')).toBe('\\')
    expect(lineTail('\\', '\x1b[D')).toBe('')
    expect(lineTail('\\', '\x1b[3~')).toBe('')
    // A deletion makes it unknown; Return moves on.
    expect(lineTail('\\', '\x7f')).toBe('')
    expect(lineTail('\\', '\r')).toBe('\r')
  })
})
