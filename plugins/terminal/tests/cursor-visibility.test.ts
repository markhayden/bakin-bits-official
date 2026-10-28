import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { cursorVisibilitySequence, trackCursorVisibility } from '../lib/cursor-visibility'
import { Screen } from '../lib/screen'

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
    expect(cursorVisibilitySequence(true)).toBe('\x1b[?25l')
    cursor.dispose()
    terminal.dispose()
  })
  it('a snapshot carries the cursor\'s visibility (a joining screen starts hidden or shown like the program left it)', async () => {
    const screen = new Screen(20, 5)
    await screen.write(new TextEncoder().encode('prompt\x1b[?25l'))
    const hidden = await screen.snapshot()
    expect(hidden.endsWith('\x1b[?25l')).toBe(true)
    await screen.write(new TextEncoder().encode('\x1b[?25h'))
    expect((await screen.snapshot()).endsWith('\x1b[?25h')).toBe(true)
    screen.close()
  })
})
