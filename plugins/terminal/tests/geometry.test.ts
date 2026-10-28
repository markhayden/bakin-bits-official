import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { installGeometry } from '../lib/geometry'
import { altEntry } from '../lib/xterm-fixes'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import { fullState, internals, linkUri, type Term } from '../lib/terminal-state'

function profiled(cols: number, rows: number): Term {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS, scrollback: 200 })
  applyTerminalProfile(terminal).setLive(false)
  return terminal
}
const write = (terminal: Term, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
const text = (terminal: Term, buffer: 'normal' | 'alternate' = 'normal') => {
  const lines = terminal.buffer[buffer === 'normal' ? 'normal' : 'alternate']
  return Array.from({ length: lines.length }, (_, y) => lines.getLine(y)!.translateToString(true))
}
/** The state a width rebase keeps: everything but the rows and the active screen's cursor, region and stops. */
function kept(terminal: Term) {
  const { modes, cursorHidden, cursorStyle, mouseEncoding, charsets, pen, parser, sequence, utf8, osc, dcs, altEntered } = fullState(terminal)
  return { modes, cursorHidden, cursorStyle, mouseEncoding, charsets, pen, parser, sequence, utf8, osc, dcs, altEntered }
}

describe('installGeometry', () => {
  it("takes tmux's lines, cursor and region, and keeps the pen, charsets, modes, parser and cursor style", async () => {
    const target = profiled(80, 10)
    await write(target, 'one\r\ntwo\r\nthree\r\n')
    // State tmux's capture cannot carry, then a CSI left unfinished.
    await write(target, '\x1b[1;31;4:3m\x1b[58:2::1:2:3m\x1b(0\x0e\x1b[?1h\x1b[?2004h\x1b[4h\x1b[?1003h\x1b[?1006h\x1b[5 q\x1b[?25l\x1b[3')
    target.resize(60, 10)
    const before = kept(target)
    // tmux's reflowed picture at the new width.
    const source = profiled(60, 10)
    await write(source, 'reflowed one\r\nreflowed two\r\n\x1b[3;5r\x1b[8;7H')
    expect(installGeometry(target, source)).toBe(true)
    expect(text(target)).toEqual(text(source))
    expect([target.buffer.active.cursorX, target.buffer.active.cursorY]).toEqual([6, 7])
    expect([internals(target).buffers.active.scrollTop, internals(target).buffers.active.scrollBottom]).toEqual([2, 4])
    expect(kept(target)).toEqual(before)
    // The unfinished CSI finishes: SGR 32 (green) applies to the next character.
    await write(target, '2mX')
    const cell = target.buffer.active.getLine(target.buffer.active.baseY + 7)!.getCell(6)!
    expect(cell.getChars()).toBe('X')
    expect(cell.getFgColor()).toBe(2)
  })
  it('moves both saved-cursor slots with the viewport: their row on the screen is kept', async () => {
    const target = profiled(40, 5)
    await write(target, 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n\x1b[2;3H\x1b7')
    target.resize(30, 5)
    const normal = internals(target).buffers.normal
    const row = normal.savedY - normal.ybase
    const source = profiled(30, 5)
    await write(source, Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\r\n'))
    installGeometry(target, source)
    expect(normal.ybase).toBe(internals(source).buffers.normal.ybase)
    expect([normal.savedX, normal.savedY - normal.ybase]).toEqual([2, row])
    // DECRC returns there.
    await write(target, '\x1b8')
    expect([target.buffer.active.cursorX, target.buffer.active.cursorY]).toEqual([2, row])
  })
  it("remaps links in tmux's cells into the target's registry (an id'd one shared, an anonymous one apart)", async () => {
    const target = profiled(40, 5)
    await write(target, '\x1b]8;id=keep;https://kept.example\x07old\x1b]8;;\x07\r\n')
    const source = profiled(40, 5)
    await write(source, '\x1b]8;id=keep;https://kept.example\x07AB\x1b]8;;\x07 \x1b]8;;https://anon.example\x07CD\x1b]8;;\x07\r\n')
    installGeometry(target, source)
    const urlAt = (x: number) => {
      const cell = target.buffer.active.getLine(0)!.getCell(x) as unknown as { bg: number; extended: { urlId: number } }
      return linkUri(target, cell.bg & 0x10000000 ? cell.extended.urlId : 0)
    }
    expect([urlAt(0), urlAt(1), urlAt(3), urlAt(4)]).toEqual(['https://kept.example', 'https://kept.example', 'https://anon.example', 'https://anon.example'])
  })
  it('on the alternate screen: both screens from tmux, the normal cursor where tmux restores it', async () => {
    const target = profiled(40, 5)
    await write(target, 'normal\r\n\x1b[?1049h\x1b[Happ screen')
    target.resize(30, 5)
    const source = profiled(30, 5)
    await write(source, 'normal reflowed\x1b[2;4H\x1b[?1049h\x1b[Happ reflowed')
    expect(installGeometry(target, source)).toBe(true)
    expect(text(target, 'alternate')[0]).toBe('app reflowed')
    expect(text(target)[0]).toBe('normal reflowed')
    // Leaving the alternate screen: the normal screen at tmux's restore point.
    await write(target, '\x1b[?1049l')
    expect([target.buffer.active.cursorX, target.buffer.active.cursorY]).toEqual([3, 1])
  })
  it('refuses when the two disagree on size or on which screen is active', async () => {
    const target = profiled(40, 5)
    expect(installGeometry(target, profiled(30, 5))).toBe(false)
    const alternate = profiled(40, 5)
    await write(alternate, '\x1b[?1049h')
    expect(installGeometry(target, alternate)).toBe(false)
  })
})

describe('installGeometry and how the alternate screen was entered', () => {
  it('entered by 47 (no return slot saved): the normal slot moves with the viewport, not to tmux', async () => {
    const target = profiled(40, 5)
    await write(target, 'normal\x1b[1;5H\x1b7\x1b[?47h\x1b[Happ')
    target.resize(30, 5)
    const normal = internals(target).buffers.normal
    const before = { x: normal.savedX, row: normal.savedY - normal.ybase }
    const source = profiled(30, 5)
    await write(source, 'normal\x1b[3;9H\x1b[?1049h\x1b[Happ')
    installGeometry(target, source)
    expect({ x: normal.savedX, row: normal.savedY - normal.ybase }).toEqual(before)
  })
})

describe('altEntry', () => {
  it('records the entry from the normal screen, keeps it while alternate, and forgets it on leaving or RIS', async () => {
    const terminal = profiled(40, 5)
    expect(altEntry(terminal)).toBeUndefined()
    await write(terminal, '\x1b[?47h')
    expect(altEntry(terminal)).toBe('unsaved')
    // 1049 while already alternate saves into the alternate slot: the entry stays what it was.
    await write(terminal, '\x1b[?1049h')
    expect(altEntry(terminal)).toBe('unsaved')
    await write(terminal, '\x1b[?47l')
    expect(altEntry(terminal)).toBeUndefined()
    await write(terminal, '\x1b[?1049h')
    expect(altEntry(terminal)).toBe('saved')
    // RIS leaves the alternate screen without a DECRST.
    await write(terminal, '\x1bc')
    expect(terminal.buffer.active.type).toBe('normal')
    expect(altEntry(terminal)).toBeUndefined()
  })
})
