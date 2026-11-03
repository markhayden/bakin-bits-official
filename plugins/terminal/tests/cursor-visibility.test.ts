import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { trackCursorVisibility } from '../lib/cursor-visibility'

const write = (terminal: InstanceType<typeof headless.Terminal>, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))

describe('cursor visibility', () => {
  it('follows DECTCEM, including combined modes, and DECSTR shows it again', async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    const cursor = trackCursorVisibility(terminal)
    expect(cursor.hidden).toBe(false)
    await write(terminal, '\x1b[?25l')
    expect(cursor.hidden).toBe(true)
    await write(terminal, '\x1b[?25;1049h')
    expect(cursor.hidden).toBe(false)
    await write(terminal, '\x1b[?1049;25l')
    expect(cursor.hidden).toBe(true)
    // 25 as a sub-parameter of another mode is not mode 25.
    await write(terminal, '\x1b[?1:25h')
    expect(cursor.hidden).toBe(true)
    await write(terminal, '\x1b[!p')
    expect(cursor.hidden).toBe(false)
    cursor.dispose()
    terminal.dispose()
  })
})
