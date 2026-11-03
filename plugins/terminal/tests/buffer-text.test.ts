import { describe, expect, it } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { bufferText } from '../lib/buffer-text'
import { applyTerminalProfile } from '../lib/terminal-profile'

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))

describe('bufferText (Copy text)', () => {
  it('is the history and the screen as plain text: wrapped rows joined back into their line, trailing blank rows dropped', async () => {
    const terminal = new Terminal({ cols: 10, rows: 4, scrollback: 100, allowProposedApi: true })
    await write(terminal, 'one\r\n' + 'a'.repeat(23) + '\r\nthree  \r\n')
    const { text, lines } = bufferText(terminal.buffer.active)
    expect(text).toBe(`one\n${'a'.repeat(23)}\nthree`)
    expect(lines).toBe(3)
    terminal.dispose()
  })
  it('a space where a row wraps stays in the line', async () => {
    const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    await write(terminal, 'aaaaaaaaa bbb')
    expect(bufferText(terminal.buffer.active).text).toBe('aaaaaaaaa bbb')
    terminal.dispose()
  })
    it('a wide character that wrapped early adds no space (the empty cell it left is not text); printed spaces there stay', async () => {
    for (const wide of ['界', '😀', '👩‍💻']) {
      const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true })
      applyTerminalProfile(terminal)
      await write(terminal, `123456789${wide}z`)
      expect(bufferText(terminal.buffer.active).text).toBe(`123456789${wide}z`)
      terminal.dispose()
    }
    const spaced = new Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    applyTerminalProfile(spaced)
    await write(spaced, '12345678 界z')
    expect(bufferText(spaced.buffer.active).text).toBe('12345678 界z')
    spaced.dispose()
  })
  it('combining marks stay with their letter', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    applyTerminalProfile(terminal)
    await write(terminal, 'cafe\u0301 ok')
    expect(bufferText(terminal.buffer.active).text).toBe('cafe\u0301 ok')
    terminal.dispose()
  })
  it('a long run of spaces before text trims in linear time', () => {
    const row = ' '.repeat(200)
    const rows = Array.from({ length: 501 }, (_, y) => ({ isWrapped: y > 0, length: 200, translateToString: () => y === 500 ? 'x' + ' '.repeat(199) : row, getCell: () => ({ getChars: () => ' ', getWidth: () => 1 }) }))
    const started = performance.now()
    expect(bufferText({ length: rows.length, getLine: (y) => rows[y] }).text.endsWith('x')).toBe(true)
    expect(performance.now() - started).toBeLessThan(200)
  })
    it('keeps colors and styles out (text only), and an empty screen is empty', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    expect(bufferText(terminal.buffer.active)).toEqual({ text: '', lines: 0 })
    await write(terminal, '\x1b[31;1mred\x1b[0m plain')
    expect(bufferText(terminal.buffer.active).text).toBe('red plain')
    terminal.dispose()
  })
})
