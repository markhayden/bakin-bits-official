import { describe, expect, it } from 'bun:test'
import { activeModifiers, afterSend, consumeModifiers, encodeTerminalKey, NO_MODIFIERS, pasteText, toggleModifier, type ModifierState } from '../components/terminal-input'

const none = { ctrl: false, alt: false }
const ctrl = { ctrl: true, alt: false }
const alt = { ctrl: false, alt: true }
const both = { ctrl: true, alt: true }

describe('terminal keys (xterm 6 encoding)', () => {
  it('respects normal and application cursor modes, and modified cursor keys use CSI 1;m', () => {
    for (const [key, suffix] of [['Up','A'],['Down','B'],['Right','C'],['Left','D'],['Home','H'],['End','F']] as const) {
      expect(encodeTerminalKey(key, false, none)).toBe('\x1b[' + suffix)
      expect(encodeTerminalKey(key, true, none)).toBe('\x1bO' + suffix)
      expect(encodeTerminalKey(key, true, ctrl)).toBe('\x1b[1;5' + suffix)
      expect(encodeTerminalKey(key, true, alt)).toBe('\x1b[1;3' + suffix)
      expect(encodeTerminalKey(key, false, both)).toBe('\x1b[1;7' + suffix)
    }
  })
  it('encodes editing keys and explicit combinations exactly', () => {
    for (const [key, bytes] of [['Esc','\x1b'],['Tab','\t'],['Enter','\r'],['Backspace','\x7f'],['Delete','\x1b[3~'],['Shift+Tab','\x1b[Z'],['Page Up','\x1b[5~'],['Page Down','\x1b[6~']] as const) expect(encodeTerminalKey(key, false, none)).toBe(bytes)
    expect(encodeTerminalKey('Delete', false, ctrl)).toBe('\x1b[3;5~')
    // xterm modifies Page Up/Down only with Ctrl; Option alone sends them plain.
    expect(encodeTerminalKey('Page Up', false, alt)).toBe('\x1b[5~')
    expect(encodeTerminalKey('Page Up', false, ctrl)).toBe('\x1b[5;5~')
    expect(encodeTerminalKey('Delete', false, alt)).toBe('\x1b[3;3~')
    expect(encodeTerminalKey('Page Down', false, both)).toBe('\x1b[6;7~')
    expect(encodeTerminalKey('Shift+Tab', false, ctrl)).toBe('\x1b[Z')
    expect(encodeTerminalKey('Ctrl+C', false, ctrl)).toBe('\x03')
    expect(encodeTerminalKey('Ctrl+C', false, alt)).toBe('\x1b\x03')
    expect(encodeTerminalKey('Tab', false, ctrl)).toBe('\t')
    expect(encodeTerminalKey('Tab', false, alt)).toBe('\t')
  })
  it('prefixes ESC for Option on the keys xterm prefixes, and Ctrl+Backspace is BS', () => {
    expect(encodeTerminalKey('Esc', false, alt)).toBe('\x1b\x1b')
    expect(encodeTerminalKey('Enter', false, alt)).toBe('\x1b\r')
    expect(encodeTerminalKey('Backspace', false, alt)).toBe('\x1b\x7f')
    expect(encodeTerminalKey('Backspace', false, ctrl)).toBe('\x08')
    expect(encodeTerminalKey('Backspace', false, both)).toBe('\x1b\x08')
  })
  it('sends literal keys as their character, with modifiers applied like typed text', () => {
    expect(encodeTerminalKey('|', false, none)).toBe('|')
    expect(encodeTerminalKey('~', false, alt)).toBe('\x1b~')
    expect(encodeTerminalKey('-', false, ctrl)).toBe('-')
    expect(encodeTerminalKey('/', false, none)).toBe('/')
  })
})

describe('typed text under the bar modifiers', () => {
  it('applies Ctrl to ASCII letters and the C0 punctuation, and Option as an ESC prefix', () => {
    expect(consumeModifiers('c', ctrl)).toBe('\x03')
    expect(consumeModifiers('C', ctrl)).toBe('\x03')
    expect(consumeModifiers(' ', ctrl)).toBe('\x00')
    expect(consumeModifiers('[', ctrl)).toBe('\x1b')
    expect(consumeModifiers('\\', ctrl)).toBe('\x1c')
    expect(consumeModifiers(']', ctrl)).toBe('\x1d')
    // Ctrl+3–7 are ESC FS GS RS US and Ctrl+8 is DEL (Ctrl+6 in Vim).
    expect(['3', '4', '5', '6', '7', '8'].map(digit => consumeModifiers(digit, ctrl))).toEqual(['\x1b', '\x1c', '\x1d', '\x1e', '\x1f', '\x7f'])
    // xterm maps Ctrl+_ (Readline undo) and Ctrl+@; other shifted characters have no control form.
    expect(consumeModifiers('_', ctrl)).toBe('\x1f')
    expect(consumeModifiers('@', ctrl)).toBe('\x00')
    for (const char of ['?', '^', '2']) expect(consumeModifiers(char, ctrl)).toBe(char)
    expect(consumeModifiers('b', alt)).toBe('\x1bb')
    expect(consumeModifiers('c', both)).toBe('\x1b\x03')
    expect(consumeModifiers(' ', both)).toBe('\x1b\x00')
    // Option + a digit or punctuation is ESC + the character; Ctrl does not apply (xterm).
    expect(consumeModifiers('6', both)).toBe('\x1b6')
    expect(consumeModifiers('.', alt)).toBe('\x1b.')
    expect(consumeModifiers('c', none)).toBe('c')
  })
  it('modifies the cursor and tilde keys a hardware keyboard types', () => {
    expect(consumeModifiers('\x1bOA', ctrl)).toBe('\x1b[1;5A')
    expect(consumeModifiers('\x1b[D', alt)).toBe('\x1b[1;3D')
    expect(consumeModifiers('\x1b[3~', both)).toBe('\x1b[3;7~')
    expect(consumeModifiers('\r', alt)).toBe('\x1b\r')
    // A typed DEL (Backspace, an autocorrect deletion, hardware Ctrl+8) is sent as typed.
    expect(consumeModifiers('\x7f', ctrl)).toBe('\x7f')
    expect(consumeModifiers('\x7f', alt)).toBe('\x7f')
  })
  it('merges the bar modifiers into keys a hardware keyboard already modified', () => {
    expect(consumeModifiers('\x1b[1;5D', alt)).toBe('\x1b[1;7D')
    expect(consumeModifiers('\x1b[1;3A', ctrl)).toBe('\x1b[1;7A')
    expect(consumeModifiers('\x1b[5;5~', alt)).toBe('\x1b[5;7~')
    expect(consumeModifiers('\x1b[5~', alt)).toBe('\x1b[5~')
    expect(consumeModifiers('\x1b[3;5~', alt)).toBe('\x1b[3;7~')
    // Keys the keyboard made into control characters: Option still prefixes them.
    expect(consumeModifiers('\x1b', alt)).toBe('\x1b\x1b')
    expect(consumeModifiers('\x03', alt)).toBe('\x1b\x03')
    expect(consumeModifiers('\x03', ctrl)).toBe('\x03')
    expect(consumeModifiers('\t', both)).toBe('\t')
    // Keys the keyboard already ESC-prefixed (Meta/Alt): the bar's Control still applies, as xterm's Ctrl+Alt does.
    expect(consumeModifiers('\x1b\x7f', ctrl)).toBe('\x1b\x08')
    expect(consumeModifiers('\x1bc', ctrl)).toBe('\x1b\x03')
    expect(consumeModifiers('\x1b ', ctrl)).toBe('\x1b\x00')
    expect(consumeModifiers('\x1b.', ctrl)).toBe('\x1b.')
    expect(consumeModifiers('\x1bc', alt)).toBe('\x1bc')
    expect(consumeModifiers('\x1b[Z', both)).toBe('\x1b[Z')
  })
  it('leaves paste, IME, words and unsupported characters as typed', () => {
    for (const data of ['ç', '你好', 'echo hello']) expect(consumeModifiers(data, both)).toBe(data)
    expect(consumeModifiers('!', ctrl)).toBe('!')
    expect(consumeModifiers('c', both, 'paste')).toBe('c')
    expect(consumeModifiers('c', both, 'composition')).toBe('c')
  })
})

describe('modifier state', () => {
  it('taps arm one-shot and cancel; a lock survives sends and a tap releases it', () => {
    let state: ModifierState = NO_MODIFIERS
    state = toggleModifier(state, 'ctrl')
    expect(state).toEqual({ ctrl: 'once', alt: 'off' })
    expect(toggleModifier(state, 'ctrl')).toEqual(NO_MODIFIERS)
    state = toggleModifier(state, 'alt', 'lock')
    expect(state).toEqual({ ctrl: 'once', alt: 'locked' })
    expect(activeModifiers(state)).toEqual(both)
    state = afterSend(state)
    expect(state).toEqual({ ctrl: 'off', alt: 'locked' })
    expect(afterSend(state)).toEqual(state)
    expect(toggleModifier(state, 'alt')).toEqual(NO_MODIFIERS)
    // Long-pressing an armed or locked key locks it (a lock never toggles off by holding).
    expect(toggleModifier({ ctrl: 'once', alt: 'off' }, 'ctrl', 'lock')).toEqual({ ctrl: 'locked', alt: 'off' })
    expect(toggleModifier({ ctrl: 'locked', alt: 'off' }, 'ctrl', 'lock')).toEqual({ ctrl: 'locked', alt: 'off' })
  })
})

describe('compose text as a paste', () => {
  it('turns line breaks into CR, as the xterm paste does', () => {
    expect(pasteText('echo one\necho two\r\nlast')).toBe('echo one\recho two\rlast')
    expect(pasteText('ls')).toBe('ls')
  })
})
