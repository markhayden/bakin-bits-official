import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { ControlClient, type ControlTransport } from '../lib/control'
import { OutputLog, type LogEvent } from '../lib/output-log'
import { RESEED_ATTEMPTS, RESEED_BACKOFF_MS, reseed, SEED_FORMATS, seedCommands, seedFrom } from '../lib/reseed'
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
    const seed = seedFrom([[formats({ history_size: '2', cursor_x: '3', cursor_y: '1', bracket_paste_flag: '1', cursor_flag: '0' })], ['old 1', 'old 2'], ['\x1b[1mbold\x1b[0m', 'two', '', '', ''], ['']])
    expect([seed.cols, seed.rows]).toEqual([20, 5])
    const terminal = await render(seed.bytes)
    expect(lines(terminal).slice(0, 4)).toEqual(['old 1', 'old 2', 'bold', 'two'])
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([3, 1])
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(terminal.buffer.active.getLine(terminal.buffer.active.baseY)!.getCell(0)!.isBold()).toBeTruthy()
  })
  it('ignores the clamped history block when tmux has no history', async () => {
    const terminal = await render(seedFrom([[formats({})], ['row zero, clamped'], ['screen'], ['']]).bytes)
    expect(lines(terminal)[0]).toBe('screen')
  })
  it('on the alternate screen, the saved normal screen goes under the program\'s screen', async () => {
    const seed = seedFrom([[formats({ alternate_on: '1', history_size: '1', alternate_saved_y: '1' })], ['history'], ['FULLSCREEN APP'], ['normal 1', 'normal 2']])
    const terminal = await render(seed.bytes)
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(lines(terminal)[0]).toBe('FULLSCREEN APP')
    terminal.write('\x1b[?1049l')
    await new Promise<void>((resolve) => terminal.write('', resolve))
    expect(lines(terminal).slice(0, 3)).toEqual(['history', 'normal 1', 'normal 2'])
  })
  it('refuses incomplete replies', () => {
    expect(() => seedFrom([['a\tb'], [], [], []])).toThrow('incomplete')
    expect(() => seedFrom([[formats({})]])).toThrow('4 replies')
  })
  it('captures only the history the replica keeps, in one group', () => {
    const commands = seedCommands('s1')
    expect(commands).toHaveLength(4)
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
const seedReplies = (n: number, screen = 'seeded') => [1, 2, 3, 4].map((k) => `%begin 2 ${n + k} 1\n${k === 1 ? formats({}) : k === 3 ? screen : ''}\n%end 2 ${n + k} 1\n`).join('')
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
    const failing = reseed(control, log, 's1', 'test', sleep)
    for (let i = 0; i < RESEED_ATTEMPTS; i++) {
      await Bun.sleep(0)
      control.feed(`%begin 3 ${n} 1\ncan't find pane\n%error 3 ${n} 1\n`)
      n++
    }
    await expect(failing).rejects.toThrow("can't find pane")
    expect(delays).toEqual(RESEED_BACKOFF_MS.slice(0, RESEED_ATTEMPTS - 1))
    expect(written).toHaveLength(RESEED_ATTEMPTS)
    expect(log.invalidReason).toStartWith('reseed failed')
  })
  it('a failure then a success seeds once', async () => {
    const { control, log } = fakeControl()
    const events: LogEvent[] = []
    log.attach({ event: (event) => { events.push(event) }, invalid: () => {} })
    const done = reseed(control, log, 's1', 'test', async () => {})
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
    const first = reseed(control, log, 's1', 'one')
    const second = reseed(control, log, 's1', 'two')
    expect(second).toBe(first)
    control.feed(seedReplies(20))
    await first
    expect(written).toHaveLength(1)
  })
  it('a closed connection is not retried: recovery reattaches instead', async () => {
    const { control, log, written } = fakeControl()
    const done = reseed(control, log, 's1', 'test', async () => {})
    control.close('test')
    await expect(done).rejects.toThrow('closed')
    expect(written).toHaveLength(1)
  })
})
