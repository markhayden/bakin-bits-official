import { describe, expect, it } from 'bun:test'
import { consumeControl, encodeTerminalKey } from '../components/terminal-input'

describe('terminal keys', () => {
  it('respects normal and application cursor modes', () => {
    for (const [key, suffix] of [['Up','A'],['Down','B'],['Right','C'],['Left','D'],['Home','H'],['End','F']] as const) {
      expect(encodeTerminalKey(key, false)).toBe('\x1b[' + suffix)
      expect(encodeTerminalKey(key, true)).toBe('\x1bO' + suffix)
      expect(encodeTerminalKey(key, true, true)).toBe('\x1b[1;5' + suffix)
    }
  })
  it('encodes editing keys and explicit combinations exactly', () => {
    for (const [key, bytes] of [['Esc','\x1b'],['Tab','\t'],['Enter','\r'],['Backspace','\x7f'],['Delete','\x1b[3~'],['Shift+Tab','\x1b[Z'],['Page Up','\x1b[5~'],['Page Down','\x1b[6~']] as const) expect(encodeTerminalKey(key, false)).toBe(bytes)
    expect(encodeTerminalKey('Delete', false, true)).toBe('\x1b[3;5~')
    expect(encodeTerminalKey('Shift+Tab', false, true)).toBe('\x1b[Z')
    expect(encodeTerminalKey('Ctrl+C', false, true)).toBe('\x03')
    expect(encodeTerminalKey('Tab', false, true)).toBe('\t')
  })
  it('consumes Ctrl once for ASCII letters and leaves paste, IME, and unsupported text intact', () => {
    expect(consumeControl('c', true)).toEqual({ data: '\x03', armed: false })
    expect(consumeControl('c', false)).toEqual({ data: 'c', armed: false })
    for (const data of ['ç', '你好', 'echo hello', '!', '\x03']) expect(consumeControl(data, true).data).toBe(data)
    expect(consumeControl('c', true, 'paste').data).toBe('c')
    expect(consumeControl('c', true, 'composition').data).toBe('c')
    expect(consumeControl('\x1bOA', true).data).toBe('\x1b[1;5A')
  })
})
