import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { applyTmuxWidths, TMUX_CELL_BYTES, tmuxWidth } from '../lib/unicode-widths'
import { TMUX_WIDTHS } from '../lib/tmux-width-table'
import { checkpointSteps } from '../lib/checkpoint'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import { drain } from '../lib/terminal-state'

type Term = InstanceType<typeof headless.Terminal>
const write = (terminal: Term, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
async function cursorAfter(text: string, table?: readonly (readonly [number, number, 0 | 1 | 2])[]): Promise<number> {
  const terminal = new headless.Terminal({ cols: 40, rows: 2, allowProposedApi: true })
  applyTmuxWidths(terminal as never, table)
  await write(terminal, text)
  const x = terminal.buffer.active.cursorX
  terminal.dispose()
  return x
}

describe('tmux widths over the grapheme provider', () => {
  it('the generated table is sorted, disjoint and in range', () => {
    let previous = -1
    for (const [first, last, width] of TMUX_WIDTHS) {
      expect(first).toBeGreaterThan(previous)
      expect(last).toBeGreaterThanOrEqual(first)
      expect([0, 1, 2]).toContain(width)
      previous = last
    }
  })
  it('looks codepoints up by range', () => {
    const table = [[0x10, 0x12, 2], [0x20, 0x20, 0]] as const
    expect(tmuxWidth(0x11, table)).toBe(2)
    expect(tmuxWidth(0x20, table)).toBe(0)
    expect(tmuxWidth(0x13, table)).toBeUndefined()
  })
  it('a wide override takes two cells; a zero-width one joins the previous cell', async () => {
    const table = [[0x200b, 0x200b, 0], [0x2630, 0x2630, 2]] as const
    expect(await cursorAfter('x☰y', [])).toBe(3)
    expect(await cursorAfter('x☰y', table)).toBe(4)
    expect(await cursorAfter('x​y', [])).toBe(3)
    expect(await cursorAfter('x​y', table)).toBe(2)
    // Joined after a wide character, it keeps the wide cell.
    expect(await cursorAfter('中​y', table)).toBe(3)
  })
  it('a zero-width entry joins at the preceding width, also where the grapheme rules would widen the cluster', async () => {
    const table = [[0x1f3fd, 0x1f3fd, 0]] as const
    expect(await cursorAfter('👍🏽X', table)).toBe(3)
    expect(await cursorAfter('a🏽X', table)).toBe(2)
  })
  it('a spacing entry applies outside clusters; a cluster the grapheme rules join keeps their width', async () => {
    const table = [[0x2630, 0x2630, 2]] as const
    expect(await cursorAfter('\u2630X', table)).toBe(3)
    // Joined after a ZWJ, the grapheme rules decide the cluster's width.
    expect(await cursorAfter('👨\u200d\u2630X', table)).toBe(await cursorAfter('👨\u200d\u2630X', []))
  })
})

describe('the tmux cell limit', () => {
  const cell = async (text: string) => {
    const terminal = new headless.Terminal({ cols: 40, rows: 2, allowProposedApi: true })
    applyTmuxWidths(terminal as never)
    await write(terminal, text)
    const line = terminal.buffer.active.getLine(0)!
    const cells = [line.getCell(0)!.getChars(), line.getCell(1)!.getChars()]
    terminal.dispose()
    return cells
  }
  it(`keeps at most ${TMUX_CELL_BYTES} bytes of UTF-8 in a cell, dropping marks past it`, async () => {
    expect(await cell(`a${'\u0301'.repeat(60)}b`)).toEqual([`a${'\u0301'.repeat(15)}`, 'b'])
    expect(await cell(`a${'\u20dd'.repeat(60)}b`)).toEqual([`a${'\u20dd'.repeat(10)}`, 'b'])
  })
  it('a code point past the limit does not widen the cell (VS16), mid-line and at the right margin, and checkpoints verify', async () => {
    const full = '\u2764' + '\u0301'.repeat(14)
    for (const [cols, at, x] of [[40, '', 2], [10, '\x1b[1;10H', 11]] as const) {
      const terminal = new headless.Terminal({ cols, rows: 3, ...TERMINAL_OPTIONS })
      applyTerminalProfile(terminal)
      await write(terminal, `${at}${full}\ufe0fX`)
      // The heart stays one cell wide: X follows it (or wraps, at the margin).
      const line = terminal.buffer.active.getLine(0)!
      expect(line.getCell(at ? 9 : 0)!.getWidth(), `cols ${cols}`).toBe(1)
      expect(at ? terminal.buffer.active.getLine(1)!.getCell(0)!.getChars() : line.getCell(1)!.getChars()).toBe('X')
      expect(terminal.buffer.active.cursorX + (at ? 10 : 0)).toBe(x)
      const result = drain(checkpointSteps(terminal))
      expect('rejected' in result ? result : 'accepted', `cols ${cols}`).toBe('accepted')
      terminal.dispose()
    }
  })
  it('measuring text outside print (the WebGL atlas) never looks at the cursor cell', async () => {
    const terminal = new headless.Terminal({ cols: 40, rows: 3, ...TERMINAL_OPTIONS })
    applyTerminalProfile(terminal)
    const service = (terminal as unknown as { _core: { unicodeService: { getStringCellWidth(text: string): number } } })._core.unicodeService
    expect(service.getStringCellWidth('\u2764\ufe0f')).toBe(2)
    await write(terminal, '\u2764' + '\u0301'.repeat(14))
    expect(service.getStringCellWidth('\u2764\ufe0f')).toBe(2)
    terminal.dispose()
  })
  it('keeps a joined emoji within the limit whole', async () => {
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}'
    expect((await cell(family))[0]).toBe(family)
  })
})
