import { describe, expect, it } from 'bun:test'
import { screenView, shadowDiff } from '../lib/shadow'
import { emulator, settled } from './helpers/terminal-fuzz'

async function view(cols: number, rows: number, data: string) {
  const terminal = emulator(cols, rows, 100)
  terminal.write(data)
  await settled(terminal)
  const result = screenView(terminal)
  terminal.dispose()
  return result
}

describe('shadow comparison', () => {
  it('allows the documented differences: attributes, trailing blanks, scrollback, a pending wrap', async () => {
    const bridge = await view(10, 3, 'old\r\nold\r\nold\r\n\x1b[2J\x1b[H\x1b[1;31mred\x1b[0m   \r\n0123456789')
    // Empty cells instead of spaces, other attributes, no history, the cursor pending a wrap.
    const replica = await view(10, 3, '\x1b[2J\x1b[H\x1b[4mred\x1b[0m\r\n0123456789')
    expect(shadowDiff(bridge, replica)).toBeNull()
    expect(replica.cursor.x).toBe(9)
  })
  it('names the first difference by kind and row, never by contents', async () => {
    const base = await view(10, 3, 'one\r\ntwo')
    expect(shadowDiff(base, await view(10, 3, 'one\r\nTWO'))).toEqual({ kind: 'row', row: 1 })
    expect(shadowDiff(base, await view(12, 3, 'one\r\ntwo'))).toEqual({ kind: 'size' })
    expect(shadowDiff(base, await view(10, 3, 'one\r\ntwo\x1b[1;1H'))).toEqual({ kind: 'cursor' })
  })
  it('compares the active screen: the alternate screen is what both show', async () => {
    const alternate = await view(10, 3, 'normal\x1b[?1049h\x1b[Halt')
    expect(alternate.text[0]).toBe('alt')
    expect(shadowDiff(alternate, await view(10, 3, 'normal\x1b[?1049h\x1b[Halt'))).toBeNull()
    expect(shadowDiff(alternate, await view(10, 3, 'alt'))).toBeNull()
  })
})
