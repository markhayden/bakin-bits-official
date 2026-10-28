import './setup-dom'
import { expect, it } from 'bun:test'
import { Terminal } from '@xterm/xterm'
import { patchEraseAbove } from '../lib/xterm-fixes'

it('the browser xterm build exposes the same internals, and the patch keeps it writing', async () => {
  const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true })
  patchEraseAbove(terminal)
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
  const handler = (terminal as unknown as { _core: { _inputHandler: Record<string, unknown> } })._core._inputHandler
  for (const name of ['_eraseInBufferLine', '_resetBufferLine', '_restrictCursor']) expect(typeof handler[name]).toBe('function')
  await write('AAAAAAAAAA\r\nBBBBBBBBBB\r\nCCCCCCCCCC\x1b[3;10H\x1b[1J')
  await write('\x1b[1;1Hok')
  expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe('ok')
  expect(terminal.buffer.active.getLine(2)!.translateToString(true)).toBe('')
  terminal.dispose()
})

it('the shared profile applies to the browser build: no replies to queries, refused links, workarounds active', async () => {
  const { applyTerminalProfile } = await import('../lib/terminal-profile')
  const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
  const replies: string[] = []
  terminal.onData(data => replies.push(data))
  applyTerminalProfile(terminal)
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
  await write('\x1b[c\x1b[6n\x1b]11;?\x07\x1b]8;;javascript:x\x1b\\LINK\x1b]8;;\x1b\\')
  expect(replies).toEqual([])
  expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe('LINK')
  terminal.dispose()
})
