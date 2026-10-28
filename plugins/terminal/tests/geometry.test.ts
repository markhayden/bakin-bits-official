import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { installGeometry } from '../lib/geometry'
import { altEntry } from '../lib/xterm-fixes'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import { fullState, internals, linkUri, type Term } from '../lib/terminal-state'

function profiled(cols: number, rows: number, scrollback = 200): Term {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS, scrollback })
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
  it("gives both screens tmux's tab stops (they are shared)", async () => {
    const target = profiled(80, 5)
    target.resize(60, 5)
    const source = profiled(60, 5)
    await write(source, '\x1b[3g\x1b[1;5H\x1bH\x1b[1;30H\x1bH\x1b[H')
    installGeometry(target, source)
    const stops = (buffer: 'normal' | 'alt') => Object.keys(internals(target).buffers[buffer].tabs).map(Number)
    expect(stops('normal')).toEqual([4, 29])
    expect(stops('alt')).toEqual([4, 29])
  })
  it('refuses when the two disagree on size or on which screen is active', async () => {
    const target = profiled(40, 5)
    expect(installGeometry(target, profiled(30, 5))).toBe(false)
    const alternate = profiled(40, 5)
    await write(alternate, '\x1b[?1049h')
    expect(installGeometry(target, alternate)).toBe(false)
  })
})

/** The link id in a cell (0 for none). */
function linkAt(terminal: Term, buffer: 'normal' | 'alternate', y: number, x: number): number {
  const cell = terminal.buffer[buffer].getLine(y)!.getCell(x) as unknown as { bg: number; extended: { urlId: number } }
  return cell.bg & 0x10000000 ? cell.extended.urlId : 0
}
type LinkEntries = Map<number, { lines: { line: number }[] }>
const linkEntries = (terminal: Term) => (internals(terminal)._oscLinkService as unknown as { _dataByLinkId: LinkEntries })._dataByLinkId
const markersOf = (terminal: Term, buffer: 'normal' | 'alt') => (internals(terminal).buffers[buffer] as unknown as { markers: unknown[] }).markers

describe('installGeometry refusals and links', () => {
  it('refuses, with nothing changed, when the source holds more lines than the target can', async () => {
    const target = profiled(30, 5, 5)
    await write(target, 'kept\r\n')
    const source = profiled(30, 5, 200)
    await write(source, Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\r\n'))
    const before = text(target)
    expect(installGeometry(target, source)).toBe(false)
    expect(text(target)).toEqual(before)
  })
  it("puts link markers on the target's own buffers: the link outlives the source, and dies with its lines", async () => {
    const target = new headless.Terminal({ cols: 30, rows: 5, ...TERMINAL_OPTIONS, scrollback: 5 })
    const { links } = applyTerminalProfile(target)
    const source = profiled(30, 5, 5)
    await write(source, '\x1b]8;;https://a.example\x07link\x1b]8;;\x07\r\n')
    installGeometry(target, source)
    const id = linkAt(target, 'normal', 0, 0)
    const entry = linkEntries(target).get(id)!
    expect(entry.lines.length).toBe(1)
    expect(markersOf(target, 'normal')).toContain(entry.lines[0])
    source.dispose()
    expect(linkUri(target, id)).toBe('https://a.example')
    // Scrolled out of the history: the marker is disposed, the entry is an orphan, and a sweep reclaims it.
    await write(target, '\r\n'.repeat(20))
    expect(entry.lines.length).toBe(0)
    links.sweep()
    expect(linkEntries(target).has(id)).toBe(false)
  })
  it('maps one source link to one target link across both screens', async () => {
    const target = profiled(30, 5)
    await write(target, '\x1b[?1049h')
    const source = profiled(30, 5)
    await write(source, '\x1b]8;;https://both.example\x07norm\x1b[?1049h\x1b[Halt\x1b]8;;\x07')
    installGeometry(target, source)
    const normal = linkAt(target, 'normal', 0, 0)
    expect(normal).not.toBe(0)
    expect(linkAt(target, 'alternate', 0, 0)).toBe(normal)
    expect(linkEntries(target).get(normal)!.lines.length).toBe(2)
  })
  it("keeps the pen's open anonymous link the same link as tmux's cells when one anonymous source link has its URI", async () => {
    const target = profiled(30, 5)
    await write(target, '\x1b]8;;https://pen.example\x07ab')
    const source = profiled(30, 5)
    await write(source, '\x1b]8;;https://pen.example\x07ab')
    installGeometry(target, source)
    await write(target, 'c')
    expect(linkAt(target, 'normal', 0, 2)).toBe(linkAt(target, 'normal', 0, 0))
  })
  it('keeps the pen apart when two anonymous source links share its URI (the recorded limit)', async () => {
    const target = profiled(30, 5)
    await write(target, '\x1b]8;;https://pen.example\x07ab')
    const source = profiled(30, 5)
    await write(source, '\x1b]8;;https://pen.example\x07a\x1b]8;;\x07 \x1b]8;;https://pen.example\x07b')
    installGeometry(target, source)
    await write(target, 'c')
    const pen = linkAt(target, 'normal', 0, 3)
    expect(linkUri(target, pen)).toBe('https://pen.example')
    expect([linkAt(target, 'normal', 0, 0), linkAt(target, 'normal', 0, 2)]).not.toContain(pen)
    expect(linkAt(target, 'normal', 0, 0)).not.toBe(linkAt(target, 'normal', 0, 2))
  })
  it('follows the output again and announces the scroll and the cursor', async () => {
    const target = profiled(30, 5)
    await write(target, Array.from({ length: 20 }, (_, i) => `t ${i}`).join('\r\n'))
    target.scrollLines(-5)
    const source = profiled(30, 5)
    await write(source, Array.from({ length: 30 }, (_, i) => `s ${i}`).join('\r\n'))
    const scrolls: number[] = []
    let moves = 0
    target.onScroll((y) => scrolls.push(y))
    target.onCursorMove(() => { moves++ })
    installGeometry(target, source)
    expect(target.buffer.active.viewportY).toBe(target.buffer.active.baseY)
    expect(scrolls.at(-1)).toBe(target.buffer.active.baseY)
    expect(moves).toBeGreaterThan(0)
    // Output keeps following (not held by the old user scroll).
    await write(target, '\r\nmore')
    expect(target.buffer.active.viewportY).toBe(target.buffer.active.baseY)
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
  it("entered by 47: the inactive normal cursor stays the target's own, not tmux's", async () => {
    // (xterm carries the alternate cursor out on 47l, so this is the state the server's checkpoint compares.)
    const target = profiled(40, 5)
    await write(target, 'normal\x1b[1;5H\x1b[?47h\x1b[Happ')
    target.resize(30, 5)
    const source = profiled(30, 5)
    await write(source, 'normal\x1b[3;9H\x1b[?1049h\x1b[Happ')
    installGeometry(target, source)
    const normal = internals(target).buffers.normal
    expect([normal.x, normal.y]).toEqual([4, 0])
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
