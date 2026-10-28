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
