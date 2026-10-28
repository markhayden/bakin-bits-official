import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { patchEraseAbove } from '../lib/xterm-fixes'
import { Screen } from '../lib/screen'

type Term = InstanceType<typeof headless.Terminal>
const write = (terminal: Term, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
/** Resolves false if the write never completes (xterm's queue wedged). */
const settles = (terminal: Term, data: string) => Promise.race([write(terminal, data).then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 300))])
const rows = (terminal: Term) => Array.from({ length: terminal.buffer.active.length }, (_, y) => terminal.buffer.active.getLine(y)!.translateToString(true))

describe('erase above (ED 1) with the cursor in the last column', () => {
  it('stock xterm 6.0.0 throws on it (this test fails once upstream fixes it: drop the patch then)', async () => {
    const stock = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    await write(stock, 'A\x1b[3;10H')
    // xterm runs this from its write queue, where the throw wedges the queue for good.
    const handler = (stock as unknown as { _core: { _inputHandler: { eraseInDisplay(params: { params: number[] }): boolean } } })._core._inputHandler
    expect(() => handler.eraseInDisplay({ params: [1] })).toThrow()
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
})
