import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { guardParser, patchEraseAbove } from '../lib/xterm-fixes'
import { applyTerminalProfile } from '../lib/terminal-profile'
import { loadGraphemeProvider } from '../lib/unicode-widths'

type Term = InstanceType<typeof headless.Terminal>
const write = (terminal: Term, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
/** Resolves false if the write never completes (xterm's queue wedged). */
const settles = (terminal: Term, data: string) => Promise.race([write(terminal, data).then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 300))])
const rows = (terminal: Term) => Array.from({ length: terminal.buffer.active.length }, (_, y) => terminal.buffer.active.getLine(y)!.translateToString(true))

describe('erase above (ED 1) with the cursor in the last column', () => {
  // Upstream tripwires, one per half of the bug. Remove patchEraseAbove only
  // when BOTH fail (upstream fixed both); one alone is not enough.
  type Handler = { eraseInDisplay(params: { params: number[] }): boolean }
  const handlerOf = (terminal: Term) => (terminal as unknown as { _core: { _inputHandler: Handler } })._core._inputHandler
  it('stock xterm 6.0.0: the bottom-row crash is still there', async () => {
    const crash = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    await write(crash, 'A\x1b[3;10H')
    expect(() => handlerOf(crash).eraseInDisplay({ params: [1] })).toThrow(/isWrapped/)
  })
  it('stock xterm 6.0.0: with scrollback, a history line\'s wrap flag is still clobbered', async () => {
    const wrong = new headless.Terminal({ cols: 10, rows: 3, scrollback: 10, allowProposedApi: true })
    await write(wrong, 'x'.repeat(25) + '\r\n1\r\n' + 'y'.repeat(15) + '\x1b[2;10H')
    expect(wrong.buffer.active.getLine(2)!.isWrapped).toBe(true)
    handlerOf(wrong).eraseInDisplay({ params: [1] })
    expect(wrong.buffer.active.getLine(2)!.isWrapped).toBe(false)
  })
  it('patched: erases above and the whole cursor row, and the terminal keeps working', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    patchEraseAbove(terminal)
    await write(terminal, 'AAAAAAAAAA\r\nBBBBBBBBBB\r\nCCCCCCCCCC\x1b[3;10H')
    expect(await settles(terminal, '\x1b[1J')).toBe(true)
    expect(rows(terminal)).toEqual(['', '', ''])
    expect(await settles(terminal, '\x1b[1;1Hok')).toBe(true)
    expect(rows(terminal)[0]).toBe('ok')
  })
  it('patched: with scrollback, the wrap flag cleared is the one below the cursor row, not a history line', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, scrollback: 10, allowProposedApi: true })
    patchEraseAbove(terminal)
    // A wrapped line in history, then the screen; the row below the cursor row is a wrapped continuation.
    await write(terminal, 'x'.repeat(25) + '\r\n1\r\n' + 'y'.repeat(15))
    const buffer = terminal.buffer.active
    const historyWrapped = () => buffer.getLine(1)!.isWrapped
    expect(historyWrapped()).toBe(true)
    // Cursor to the last column of screen row 2 (the row above the wrapped continuation).
    await write(terminal, '\x1b[2;10H\x1b[1J')
    expect(historyWrapped()).toBe(true)
    expect(buffer.getLine(buffer.baseY + 2)!.isWrapped).toBe(false)
  })
  it('the selective form (DECSED, CSI ? 1 J) is safe too', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    patchEraseAbove(terminal)
    await write(terminal, 'A\x1b[3;10H')
    expect(await settles(terminal, '\x1b[?1J')).toBe(true)
    expect(await settles(terminal, 'after')).toBe(true)
  })
  it('elsewhere, xterm handles ED 1 itself', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    patchEraseAbove(terminal)
    await write(terminal, 'AAAAAAAAAA\r\nBBBBB\x1b[2;3H\x1b[1J')
    expect(rows(terminal)).toEqual(['', '   BB', ''])
  })
  it('the profile patches it: the sequence no longer wedges a terminal\'s output', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    applyTerminalProfile(terminal)
    expect(await settles(terminal, 'A\x1b[3;10H\x1b[1J')).toBe(true)
    await write(terminal, '\x1b[1;1Hstill here')
    expect(rows(terminal).join('\n')).toContain('still here')
    terminal.dispose()
  })
})

describe('guardParser', () => {
  it('a parser exception is reported once instead of wedging the terminal: later writes still call back, parsing nothing', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    const failures: unknown[] = []
    const parser = guardParser(terminal, (error) => failures.push(error))
    terminal.parser.registerCsiHandler({ final: 'z' }, () => { throw new Error('boom') })
    expect(await settles(terminal, '\x1b[z')).toBe(true)
    expect(parser.failed).toBe(true)
    expect(await settles(terminal, 'more')).toBe(true)
    expect(rows(terminal).join('')).not.toContain('more')
    expect(failures).toHaveLength(1)
    terminal.dispose()
  })
  it('an async handler rejecting fails it without an unhandled rejection', async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    const parser = guardParser(terminal, () => undefined)
    terminal.parser.registerCsiHandler({ final: 'z' }, () => Promise.reject(new Error('async boom')) as unknown as boolean)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(await settles(terminal, '\x1b[z')).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
      expect(parser.failed).toBe(true)
    } finally { process.off('unhandledRejection', onUnhandled); terminal.dispose() }
  })
})

describe('UTF-8 split across writes', () => {
  const zwj = Buffer.from('🧑\u200d💻X')
  const writeBytes = (terminal: Term, data: Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve))
  it('stock xterm 6.0.0 drops a held character whose continuation byte carries no payload (fails once upstream fixes it)', async () => {
    const stock = new headless.Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    loadGraphemeProvider(stock as never)
    // Split after E2 80, inside the ZWJ: the held 0x80 ends xterm's count early.
    await writeBytes(stock, zwj.subarray(0, 6))
    await writeBytes(stock, zwj.subarray(6))
    expect(stock.buffer.active.getLine(0)!.translateToString(true)).toBe('🧑💻X')
  })
  it('patched, every split point lays out like the whole write', async () => {
    const text = Buffer.from('🧑\u200d💻X中é€\u{1F004}')
    const whole = new headless.Terminal({ cols: 30, rows: 2, allowProposedApi: true })
    applyTerminalProfile(whole)
    await writeBytes(whole, text)
    for (let at = 1; at < text.length; at++) {
      const terminal = new headless.Terminal({ cols: 30, rows: 2, allowProposedApi: true })
      applyTerminalProfile(terminal)
      await writeBytes(terminal, text.subarray(0, at))
      await writeBytes(terminal, text.subarray(at))
      expect(terminal.buffer.active.getLine(0)!.translateToString(true), `split at ${at}`).toBe(whole.buffer.active.getLine(0)!.translateToString(true))
      expect(terminal.buffer.active.cursorX, `split at ${at}`).toBe(whole.buffer.active.cursorX)
    }
  })
  it('a write past xterm\'s own 128 KiB parse split keeps a three-byte character across it whole', async () => {
    for (let lead = 0; lead < 3; lead++) {
      const terminal = new headless.Terminal({ cols: 80, rows: 2, scrollback: 0, allowProposedApi: true })
      applyTerminalProfile(terminal)
      await writeBytes(terminal, Buffer.from('a'.repeat(131072 - 1 - lead) + '漢X'))
      const buffer = terminal.buffer.active
      const end = buffer.getLine(buffer.baseY + buffer.cursorY - 1)!.translateToString(true) + buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(true)
      expect(end, `lead at ${lead}`).toEndWith('漢X')
    }
  })
  it('a held character is xterm\'s own state again: a reset treats it exactly as stock xterm does', async () => {
    const run = async (profiled: boolean) => {
      const terminal = new headless.Terminal({ cols: 20, rows: 2, allowProposedApi: true })
      if (profiled) applyTerminalProfile(terminal)
      terminal.write(Uint8Array.of(0xe4), () => terminal.reset())
      terminal.write(Uint8Array.of(0xb8))
      await writeBytes(terminal, Uint8Array.of(0xad))
      return terminal.buffer.active.getLine(0)!.translateToString(true)
    }
    expect(await run(true)).toBe(await run(false))
  })
  it('invalid input (a run of continuation bytes) is still written, and settles', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 2, scrollback: 0, allowProposedApi: true })
    applyTerminalProfile(terminal)
    const bytes = new Uint8Array(200_000).fill(0x80)
    bytes[bytes.length - 1] = 0x41
    await writeBytes(terminal, bytes)
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toContain('A')
  })
})

describe('tab stops across alternate-screen switches', () => {
  const tabbed = '\x1b[3g\x1b[1;5H\x1bH\x1b[H'
  const column = (terminal: Term) => new Promise<number>((resolve) => terminal.write('\tX', () => resolve(terminal.buffer.active.cursorX - 1)))
  it('stock xterm 6.0.0 resets the alternate buffer\'s stops on every entry (fails once upstream shares them)', async () => {
    const stock = new headless.Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    await write(stock, tabbed + '\x1b[?1049h')
    expect(await column(stock)).toBe(8)
  })
  it('patched, one set of stops holds across switches, set from either buffer, as in tmux', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    applyTerminalProfile(terminal)
    await write(terminal, tabbed + '\x1b[?1049h')
    expect(await column(terminal)).toBe(4)
    await write(terminal, '\x1b[?1049l\x1b[?1049h\r')
    expect(await column(terminal)).toBe(4)
    // Changed on the alternate screen, kept after leaving it.
    await write(terminal, '\x1b[3g\x1b[1;3H\x1bH\x1b[?1049l\r')
    expect(await column(terminal)).toBe(2)
  })
  it('leaving an alternate screen whose width changed resets the stops, as tmux does', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    applyTerminalProfile(terminal)
    await write(terminal, '\x1b[?1049h')
    terminal.resize(30, 3)
    await write(terminal, tabbed + '\x1b[?1049l\x1b[H')
    expect(await column(terminal)).toBe(8)
  })
})

describe('a grapheme cluster split across writes at the margin (wraparound off)', () => {
  const lead = '\x1b[?7l\x1b[1;10HZ'
  const first = '👨\u200d'
  const rest = '👩\u200d👧X'
  const layouts = async (make: () => Term) => {
    const whole = make()
    await write(whole, lead + first + rest)
    const split = make()
    await write(split, lead + first)
    await write(split, rest)
    const row = (term: Term) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => (term.buffer.active.getLine(0)!.getCell(x) as unknown as { getChars(): string }).getChars()).join('|')
    return [row(whole), row(split)]
  }
  it('stock xterm 6.0.0 lays the split write out differently (fails once upstream fixes it)', async () => {
    const [whole, split] = await layouts(() => {
      const term = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
      loadGraphemeProvider(term as never)
      ;(term as unknown as { unicode: { activeVersion: string } }).unicode.activeVersion = '15-graphemes'
      return term
    })
    expect(split).not.toBe(whole)
  })
  it('patched, a wide character overwritten in its second cell across writes keeps the same layout', async () => {
    const make = () => { const term = new headless.Terminal({ cols: 2, rows: 1, allowProposedApi: true }); applyTerminalProfile(term); return term }
    const whole = make()
    await write(whole, '\x1b[?7l漢漢X')
    const split = make()
    await write(split, '\x1b[?7l漢漢')
    await write(split, 'X')
    const cells = (term: Term) => [0, 1].map((x) => { const cell = term.buffer.active.getLine(0)!.getCell(x)!; return `${cell.getChars()}/${cell.getWidth()}` }).join('|')
    expect(cells(split)).toBe(cells(whole))
  })
  it('patched, a print after an ignored escape keeps xterm\'s clear (only a write boundary is a continuation)', async () => {
    const run = async (profiled: boolean) => {
      const term = new headless.Terminal({ cols: 2, rows: 1, allowProposedApi: true })
      if (profiled) applyTerminalProfile(term)
      else { loadGraphemeProvider(term as never); (term as unknown as { unicode: { activeVersion: string } }).unicode.activeVersion = '15-graphemes' }
      // A malformed CSI is ignored, and xterm keeps the join state through it.
      await write(term, '\x1b[?7l漢漢\x1b[1?mX')
      return [0, 1].map((x) => { const cell = term.buffer.active.getLine(0)!.getCell(x)!; return `${cell.getChars()}/${cell.getWidth()}` }).join('|')
    }
    expect(await run(true)).toBe(await run(false))
  })
  it('patched, every three-part byte partition lays out like the whole write (a partial write decodes to nothing)', async () => {
    const data = Buffer.from('\x1b[?7l\x1b[1;10HZ👨\u200d👩\u200d👧X')
    const make = () => { const term = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true }); applyTerminalProfile(term); return term }
    const cells = (term: Term) => Array.from({ length: 10 }, (_, x) => { const cell = term.buffer.active.getLine(0)!.getCell(x)!; return `${cell.getChars()}/${cell.getWidth()}` }).join('|')
    const whole = make()
    await new Promise<void>((resolve) => whole.write(data, resolve))
    const expected = cells(whole)
    for (let a = 1; a < data.length; a++) for (let b = a + 1; b < data.length; b++) {
      const split = make()
      for (const part of [data.subarray(0, a), data.subarray(a, b), data.subarray(b)]) await new Promise<void>((resolve) => split.write(part, resolve))
      expect(cells(split), `split at ${a}, ${b}`).toBe(expected)
    }
  })
  it('patched, chunking does not change the layout', async () => {
    const [whole, split] = await layouts(() => {
      const term = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
      applyTerminalProfile(term)
      return term
    })
    expect(split).toBe(whole)
  })
})
