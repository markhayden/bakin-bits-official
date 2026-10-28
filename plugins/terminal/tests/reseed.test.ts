import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { ControlClient, type ControlTransport } from '../lib/control'
import { OutputLog, type LogEvent } from '../lib/output-log'
import { capturedRowWidth, RESEED_ATTEMPTS, RESEED_BACKOFF_MS, reseed, SEED_FORMATS, seedCommands, seedFrom } from '../lib/reseed'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'

const formats = (values: Partial<Record<typeof SEED_FORMATS[number], string>>) => {
  const base: Record<string, string> = {
    cursor_x: '0', cursor_y: '0', cursor_flag: '1', keypad_cursor_flag: '0', keypad_flag: '0', insert_flag: '0', origin_flag: '0', wrap_flag: '1',
    bracket_paste_flag: '0', mouse_standard_flag: '0', mouse_button_flag: '0', mouse_any_flag: '0', mouse_sgr_flag: '0', focus_flag: '0',
    scroll_region_upper: '0', scroll_region_lower: '4', alternate_on: '0', alternate_saved_x: '0', alternate_saved_y: '0', pane_tabs: '8,16',
    history_size: '0', pane_width: '20', pane_height: '5',
  }
  return SEED_FORMATS.map((name) => values[name] ?? base[name]).join('\t')
}
async function render(bytes: Uint8Array, cols = 20, rows = 5) {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
  applyTerminalProfile(terminal)
  await new Promise<void>((resolve) => terminal.write(bytes, resolve))
  return terminal
}
const lines = (terminal: InstanceType<typeof headless.Terminal>) => Array.from({ length: terminal.buffer.active.length }, (_, y) => terminal.buffer.active.getLine(y)!.translateToString(true))

describe('seedFrom', () => {
  it('rebuilds history, screen, cursor, tabs and modes', async () => {
    const seed = seedFrom([[formats({ history_size: '2', cursor_x: '3', cursor_y: '1', bracket_paste_flag: '1', cursor_flag: '0' })], ['old 1', 'old 2'], ['\x1b[1mbold\x1b[0m', 'two', '', '', ''], [''], []])
    expect([seed.cols, seed.rows]).toEqual([20, 5])
    const terminal = await render(seed.bytes)
    expect(lines(terminal).slice(0, 4)).toEqual(['old 1', 'old 2', 'bold', 'two'])
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([3, 1])
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(terminal.buffer.active.getLine(terminal.buffer.active.baseY)!.getCell(0)!.isBold()).toBeTruthy()
  })
  it('a screen seed carries no history: no history capture asked for, the rest in order', async () => {
    const full = seedCommands('%1')
    const screen = seedCommands('%1', 'screen')
    expect(full).toHaveLength(5)
    expect(screen).toEqual([full[0], full[2], full[3], full[4]])
    // tmux has history, the seed still has none: the screen is the first block.
    const terminal = await render(seedFrom([[formats({ history_size: '500' })], ['on screen'], [''], []], 'screen').bytes)
    expect(terminal.buffer.active.length).toBe(terminal.rows)
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe('on screen')
    expect(() => seedFrom([[formats({})], [], [''], [], []], 'screen')).toThrow('needs 4 replies')
  })
  it('ignores the clamped history block when tmux has no history', async () => {
    const terminal = await render(seedFrom([[formats({})], ['row zero, clamped'], ['screen'], [''], []]).bytes)
    expect(lines(terminal)[0]).toBe('screen')
  })
  it('on the alternate screen, the saved normal screen goes under the program\'s screen', async () => {
    const seed = seedFrom([[formats({ alternate_on: '1', history_size: '1', alternate_saved_y: '1' })], ['history'], ['FULLSCREEN APP'], ['normal 1', 'normal 2'], []])
    const terminal = await render(seed.bytes)
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(lines(terminal)[0]).toBe('FULLSCREEN APP')
    terminal.write('\x1b[?1049l')
    await new Promise<void>((resolve) => terminal.write('', resolve))
    expect(lines(terminal).slice(0, 3)).toEqual(['history', 'normal 1', 'normal 2'])
  })
  it('a pending wrap stays pending: the next character wraps instead of overwriting the last column', async () => {
    const full = '12345678901234567890'
    const seed = seedFrom([[formats({ cursor_x: '20', cursor_y: '0' })], [], [full], [''], [full]])
    const terminal = await render(seed.bytes)
    await new Promise<void>((resolve) => terminal.write('X', resolve))
    expect(lines(terminal).slice(0, 2)).toEqual([full, 'X'])
  })
  it('a pending wrap on a row cleared after the wrap began still wraps the next character', async () => {
    // tmux: 20 characters, then CSI 2 K (default background): the row is empty, the cursor still past the last column.
    const seed = seedFrom([[formats({ cursor_x: '20', cursor_y: '0' })], [], [''], [''], ['']])
    const terminal = await render(seed.bytes)
    await new Promise<void>((resolve) => terminal.write('X', resolve))
    // The cleared cells come back as spaces (D13's empty-cell degradation).
    expect(lines(terminal)[0]!.trim()).toBe('')
    expect(lines(terminal)[1]).toBe('X')
  })
  it('measures captured rows as the profile prints them', () => {
    expect(capturedRowWidth('\x1b[31mab\x1b[0m中', 20, [8, 16])).toBe(4)
    expect(capturedRowWidth('a\tb', 20, [4])).toBe(5)
    expect(capturedRowWidth('👍🏽x', 20, [])).toBe(3)
    expect(capturedRowWidth('\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\', 20, [])).toBe(4)
    expect(capturedRowWidth('x'.repeat(30), 20, [])).toBe(20)
  })
  it('tab stops hold on the alternate screen, also on a later entry', async () => {
    const seed = seedFrom([[formats({ alternate_on: '1', pane_tabs: '4' })], [], ['\tX', '', '', '', ''], ['normal'], []])
    const terminal = await render(seed.bytes)
    expect(lines(terminal)[0]).toBe('    X')
    await new Promise<void>((resolve) => terminal.write('\x1b[?1049l\x1b[?1049h\x1b[H\tY', resolve))
    expect(lines(terminal)[0]).toBe('    Y')
  })
  it('attributes never leak from one block or row into the next', async () => {
    // Red text ends history; the screen starts in the default colour.
    const seed = seedFrom([[formats({ history_size: '1' })], ['\x1b[31mred'], ['plain', '', '', '', ''], [''], []])
    const terminal = await render(seed.bytes)
    const plain = terminal.buffer.active.getLine(1)!.getCell(0)!
    expect(plain.getChars()).toBe('p')
    expect(plain.isFgDefault()).toBe(true)
  })
  it('a row break while a background is active does not paint the next row (tmux carries attributes across rows)', async () => {
    // Six rows into five: the last break scrolls. The red background runs into row 5 and stops after "ab".
    const seed = seedFrom([[formats({ history_size: '1' })], ['history'], ['one', 'two', 'three', '\x1b[41mred row  ', 'ab\x1b[49m plain'], [''], []])
    const terminal = await render(seed.bytes)
    const buffer = terminal.buffer.active
    const last = buffer.getLine(buffer.baseY + 4)!
    expect(last.translateToString(true)).toBe('ab plain')
    // Carried: "ab" is red; after the reset, the rest of the row is default.
    expect(last.getCell(0)!.isBgDefault()).toBe(false)
    expect(last.getCell(15)!.isBgDefault()).toBe(true)
  })
  it('tab stops are in place before captured rows with literal tabs are replayed', async () => {
    const seed = seedFrom([[formats({ pane_tabs: '4' })], [], ['\tX', '', '', '', ''], [''], []])
    const terminal = await render(seed.bytes)
    expect(lines(terminal)[0]).toBe('    X')
  })
  it('refuses incomplete replies', () => {
    expect(() => seedFrom([['a\tb'], [], [], [], []])).toThrow('incomplete')
    expect(() => seedFrom([[formats({})]])).toThrow('5 replies')
  })
  it('captures only the history the replica keeps, in one group', () => {
    const commands = seedCommands('s1')
    expect(commands).toHaveLength(5)
    expect(commands[1]).toContain(String(-TERMINAL_OPTIONS.scrollback))
  })
})

function fakeControl() {
  const written: string[] = []
  let exit!: (code: number) => void
  const transport: ControlTransport = { write: (line) => { written.push(line) }, close: () => exit(0), exited: new Promise((resolve) => { exit = resolve }) }
  const log = new OutputLog()
  const control = new ControlClient(transport, { output: (_pane, bytes) => log.output(bytes) })
  control.feed('%begin 1 1 0\n%end 1 1 0\n')
  return { control, log, written }
}
const seedReplies = (n: number, screen = 'seeded') => [1, 2, 3, 4, 5].map((k) => `%begin 2 ${n + k} 1\n${k === 1 ? formats({}) : k === 3 ? screen : ''}\n%end 2 ${n + k} 1\n`).join('')
const text = (event: LogEvent) => event.kind === 'layout' ? `<${event.cols}x${event.rows}>` : `${event.kind}:${new TextDecoder().decode(event.bytes).replaceAll('\x1b', '⎋').slice(0, 12)}`

describe('reseed', () => {
  it('lands at the group\'s final reply: output before it is queued first, output after follows it', async () => {
    const { control, log } = fakeControl()
    const events: LogEvent[] = []
    log.attach({ event: (event) => { events.push(event) }, invalid: () => {} })
    const done = reseed(control, log, 's1', 'test')
    // One chunk: output, the four replies, then more output.
    control.feed(`%output %0 before\n${seedReplies(1)}%output %0 after\n`)
    await done
    log.flush()
    await Bun.sleep(0)
    expect(events.map((event) => event.kind)).toEqual(['output', 'seed', 'output'])
    expect(events.map(text)[0]).toBe('output:before')
    expect(events.map(text)[2]).toBe('output:after')
    expect(events[1]!.kind === 'seed' && events[1]!.reason).toBe('test')
  })
  it('retries with backoff, one capture at a time, then gives up and invalidates the log', async () => {
    const { control, log, written } = fakeControl()
    const delays: number[] = []
    let n = 10
    const sleep = async (ms: number) => { delays.push(ms) }
    const failing = reseed(control, log, 's1', 'test', { sleep })
    for (let i = 0; i < RESEED_ATTEMPTS; i++) {
      await Bun.sleep(0)
      control.feed(`%begin 3 ${n} 1\ncan't find pane\n%error 3 ${n} 1\n`)
      n++
    }
    await expect(failing).rejects.toThrow("can't find pane")
    expect(RESEED_BACKOFF_MS).toHaveLength(RESEED_ATTEMPTS - 1)
    expect(delays).toEqual([...RESEED_BACKOFF_MS])
    expect(written).toHaveLength(RESEED_ATTEMPTS)
    expect(log.invalidReason).toStartWith('reseed failed')
  })
  it('a failure then a success seeds once', async () => {
    const { control, log } = fakeControl()
    const events: LogEvent[] = []
    log.attach({ event: (event) => { events.push(event) }, invalid: () => {} })
    const done = reseed(control, log, 's1', 'test', { sleep: async () => {} })
    control.feed("%begin 3 1 1\nbusy\n%error 3 1 1\n")
    await Bun.sleep(0)
    control.feed(seedReplies(10))
    await done
    await Bun.sleep(0)
    expect(events.map((event) => event.kind)).toEqual(['seed'])
    expect(log.invalidReason).toBeUndefined()
  })
  it('concurrent reseeds share the attempt in flight', async () => {
    const { control, log, written } = fakeControl()
    log.attach({ event: () => {}, invalid: () => {} })
    const first = reseed(control, log, 's1', 'one')
    const second = reseed(control, log, 's1', 'two')
    expect(second).toBe(first)
    control.feed(seedReplies(20))
    await first
    expect(written).toHaveLength(1)
  })
  it('a seed the log does not keep (it overflowed meanwhile) is a failure, not a success', async () => {
    const { control, log } = fakeControl()
    log.attach({ event: () => {}, invalid: () => {} })
    const done = reseed(control, log, 's1', 'test', { sleep: async () => {} })
    log.invalidate('overflow')
    control.feed(seedReplies(30))
    await expect(done).rejects.toThrow()
  })
  it('a closed connection is not retried: recovery reattaches instead', async () => {
    const { control, log, written } = fakeControl()
    const done = reseed(control, log, 's1', 'test', { sleep: async () => {} })
    control.close('test')
    await expect(done).rejects.toThrow('closed')
    expect(written).toHaveLength(1)
  })
})
