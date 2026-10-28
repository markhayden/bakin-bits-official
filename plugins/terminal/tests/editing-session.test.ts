import { describe, expect, it } from 'bun:test'
import { enterHidesKeyboard, nextSession, type SessionEvent } from '../components/editing-session'

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
  const enter = { key: 'Enter', code: '', isComposing: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
  it('for an on-screen keyboard: no physical key code, or a visibly covered screen', () => {
    expect(enterHidesKeyboard(enter, undefined)).toBe(true)
    expect(enterHidesKeyboard({ ...enter, code: 'Enter' }, 300)).toBe(true)
  })
  it('not for a hardware keyboard (a physical key code and an uncovered screen)', () => {
    expect(enterHidesKeyboard({ ...enter, code: 'Enter' }, 0)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, code: 'NumpadEnter' }, 55)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, code: 'Enter' }, undefined)).toBe(false)
  })
  it('not for other keys, an IME confirming its text, or a modified Enter', () => {
    expect(enterHidesKeyboard({ ...enter, key: 'a' }, 300)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, isComposing: true }, 300)).toBe(false)
    expect(enterHidesKeyboard({ ...enter, shiftKey: true }, 300)).toBe(false)
  })
})
