import { describe, expect, it } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { bufferText } from '../lib/buffer-text'

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
    it('keeps colors and styles out (text only), and an empty screen is empty', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    expect(bufferText(terminal.buffer.active)).toEqual({ text: '', lines: 0 })
    await write(terminal, '\x1b[31;1mred\x1b[0m plain')
    expect(bufferText(terminal.buffer.active).text).toBe('red plain')
    terminal.dispose()
  })
})
