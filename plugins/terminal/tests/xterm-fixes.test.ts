import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { patchEraseAbove, WRITE_PIECE } from '../lib/xterm-fixes'
import { Screen } from '../lib/screen'
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
  it('the server Screen is patched: the sequence no longer wedges its output', async () => {
    const screen = new Screen(10, 3)
    await screen.write(new TextEncoder().encode('A\x1b[3;10H\x1b[1J'))
    await screen.write(new TextEncoder().encode('\x1b[1;1Hstill here'))
    expect(screen.text()).toContain('still here')
    screen.close()
  })
  it('a parser exception fails the Screen instead of wedging it: writes and captures reject, drain settles', async () => {
    const screen = new Screen(10, 3)
    const terminal = (screen as unknown as { terminal: Term }).terminal
    terminal.parser.registerCsiHandler({ final: 'z' }, () => { throw new Error('boom') })
    await expect(screen.write(new TextEncoder().encode('\x1b[z'))).rejects.toThrow('reconnect required')
    expect(screen.failed).toBe(true)
    await expect(screen.write(new TextEncoder().encode('more'))).rejects.toThrow()
    await expect(screen.snapshot()).rejects.toThrow()
    await screen.drain()
    screen.close()
  })
  it('an async handler rejecting fails the Screen without an unhandled rejection', async () => {
    const screen = new Screen(10, 3)
    const terminal = (screen as unknown as { terminal: Term }).terminal
    terminal.parser.registerCsiHandler({ final: 'z' }, () => Promise.reject(new Error('async boom')) as unknown as boolean)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(screen.write(new TextEncoder().encode('\x1b[z'))).rejects.toThrow('reconnect required')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
      expect(screen.failed).toBe(true)
      await screen.drain()
    } finally { process.off('unhandledRejection', onUnhandled); screen.close() }
  })
  it('a write that throws on submission fails the Screen and releases its charge; queued writes release theirs', async () => {
    const screen = new Screen(10, 3)
    const terminal = (screen as unknown as { terminal: Term & { write: unknown } }).terminal
    terminal.write = () => { throw new Error('submit boom') }
    const first = screen.write(new TextEncoder().encode('abc'))
    const second = screen.write(new TextEncoder().encode('queued'))
    const [one, two] = await Promise.allSettled([first, second])
    expect(one.status === 'rejected' && String(one.reason)).toContain('submit boom')
    // Queued together, they were one submission: both fail with it.
    expect(two.status === 'rejected' && String(two.reason)).toContain('submit boom')
    // A write after the failure is refused at once.
    await expect(screen.write(new TextEncoder().encode('later'))).rejects.toThrow('reconnect required')
    expect(screen.failed).toBe(true)
    expect((screen as unknown as { queuedBytes: number }).queuedBytes).toBe(0)
    await expect(screen.snapshot()).rejects.toThrow()
    await expect(screen.snapshot()).rejects.toThrow()
    screen.close()
  })
})

describe('UTF-8 chunk boundaries', () => {
  const zwj = Buffer.from('🧑‍💻X')
  // Split inside the ZWJ, after its first two bytes.
  const splitAt = 6
  const writeBytes = (terminal: Term, data: Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve))
  it('stock xterm 6.0.0 loses the grapheme join across a split codepoint (fails once upstream fixes it)', async () => {
    const stock = new headless.Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    loadGraphemeProvider(stock as never)
    await writeBytes(stock, zwj.subarray(0, splitAt))
    await writeBytes(stock, zwj.subarray(splitAt))
    expect(stock.buffer.active.cursorX).toBe(5)
  })
  it('patched, every split point lays out like the whole write', async () => {
    for (let at = 1; at < zwj.length; at++) {
      const terminal = new headless.Terminal({ cols: 20, rows: 2, allowProposedApi: true })
      applyTerminalProfile(terminal)
      await writeBytes(terminal, zwj.subarray(0, at))
      await writeBytes(terminal, zwj.subarray(at))
      expect(terminal.buffer.active.cursorX, `split at ${at}`).toBe(3)
    }
  })
  it('a large write never reaches xterm\'s own 128 KiB split inside a codepoint', async () => {
    const text = 'a'.repeat(131066) + '🧑\u200d💻X'
    const terminal = new headless.Terminal({ cols: 80, rows: 2, scrollback: 0, allowProposedApi: true })
    applyTerminalProfile(terminal)
    await writeBytes(terminal, Buffer.from(text))
    const whole = new headless.Terminal({ cols: 80, rows: 2, scrollback: 0, allowProposedApi: true })
    applyTerminalProfile(whole)
    for (let offset = 0; offset < text.length; offset += 4096) await new Promise<void>(resolve => whole.write(text.slice(offset, offset + 4096), resolve))
    expect(terminal.buffer.active.cursorX).toBe(whole.buffer.active.cursorX)
    // The same text as one string write.
    const string = new headless.Terminal({ cols: 80, rows: 2, scrollback: 0, allowProposedApi: true })
    applyTerminalProfile(string)
    await new Promise<void>(resolve => string.write(text, resolve))
    expect(string.buffer.active.cursorX).toBe(whole.buffer.active.cursorX)
  })
  it('a four-byte character cut at every offset across a piece boundary is kept whole', async () => {
    for (let lead = 0; lead < 4; lead++) {
      const text = 'a'.repeat(WRITE_PIECE - 1 - lead) + '🀄X'
      const terminal = new headless.Terminal({ cols: 80, rows: 2, scrollback: 0, allowProposedApi: true })
      applyTerminalProfile(terminal)
      await writeBytes(terminal, Buffer.from(text))
      const buffer = terminal.buffer.active
      // The text wraps: its end is on the cursor's row (🀄 may have wrapped onto it).
      const end = buffer.getLine(buffer.baseY + buffer.cursorY - 1)!.translateToString(true) + buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(true)
      expect(end, `lead at ${lead}`).toEndWith('🀄X')
    }
  })
  it('invalid input (a run of continuation bytes past a piece boundary) is still written, and settles', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 2, scrollback: 0, allowProposedApi: true })
    applyTerminalProfile(terminal)
    const bytes = new Uint8Array(200_000).fill(0x80)
    bytes[bytes.length - 1] = 0x41
    await writeBytes(terminal, bytes)
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toContain('A')
  })
  it('a string write drops a carried tail instead of handing it to xterm\'s decoder', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    applyTerminalProfile(terminal)
    await writeBytes(terminal, Uint8Array.from([0xe4, 0xb8]))
    await new Promise<void>(resolve => terminal.write('', resolve))
    terminal.reset()
    await writeBytes(terminal, Uint8Array.from([0xad, 0x41]))
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).not.toContain('中')
  })
  it('a write of only an incomplete sequence still settles; a reset drops the carried bytes', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    applyTerminalProfile(terminal)
    await writeBytes(terminal, Uint8Array.from([0xe4, 0xb8]))
    terminal.reset()
    await writeBytes(terminal, Uint8Array.from([0xad, 0x41]))
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).not.toContain('中')
  })
})
