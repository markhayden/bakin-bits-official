/**
 * The reseed core (spec D13, plan T31c): rebuild a replica's picture from
 * tmux in ONE grouped command, so nothing the pane prints can land between
 * the parts of the capture. Its boundary is the group's final reply: every
 * log event before it has already been queued for the replica, and every
 * byte after it follows the seed (lib/output-log.ts `seed`).
 *
 * A seed from tmux alone is a recovery, not a perfect copy (D13's measured
 * degradations: the current pen, the saved-cursor slot, charsets, cursor
 * style, a program paused mid-escape, empty cells as spaces, …).
 */
import type { ControlClient } from './control'
import type { OutputLog } from './output-log'
import { TERMINAL_OPTIONS } from './terminal-profile'
import { profileWidths, textWidth } from './unicode-widths'

/** Pane state the seed restores, read in the same group as the captures. */
export const SEED_FORMATS = [
  'cursor_x', 'cursor_y', 'cursor_flag', 'keypad_cursor_flag', 'keypad_flag', 'insert_flag', 'origin_flag', 'wrap_flag',
  'bracket_paste_flag', 'mouse_standard_flag', 'mouse_button_flag', 'mouse_any_flag', 'mouse_sgr_flag', 'focus_flag',
  'scroll_region_upper', 'scroll_region_lower', 'alternate_on', 'alternate_saved_x', 'alternate_saved_y', 'pane_tabs',
  'history_size', 'pane_width', 'pane_height',
] as const

/**
 * The commands of one seed: the formats, the newest history rows the
 * replica keeps, the screen, (on the alternate screen) the saved normal
 * screen, and the screen again as visual rows (for a pending wrap). Rows
 * are captured with attributes (-e), trailing spaces kept (-N) and, except
 * the last, wrapped lines joined (-J).
 */
export function seedCommands(target: string, history = TERMINAL_OPTIONS.scrollback): string[][] {
  return [
    ['display-message', '-p', '-t', target, SEED_FORMATS.map((name) => `#{${name}}`).join('\t')],
    // -E -1 clamps to row 0 when there is no history: history_size (same group) says whether this block is real.
    ['capture-pane', '-p', '-e', '-J', '-N', '-S', String(-history), '-E', '-1', '-t', target],
    ['capture-pane', '-p', '-e', '-J', '-N', '-S', '0', '-E', '-', '-t', target],
    ['capture-pane', '-p', '-e', '-J', '-N', '-a', '-q', '-t', target],
    ['capture-pane', '-p', '-e', '-N', '-S', '0', '-E', '-', '-t', target],
  ]
}

export interface Seed {
  /** Bytes that rebuild a reset terminal to the captured picture. */
  bytes: Uint8Array
  cols: number
  rows: number
}

const number = (formats: Record<string, string>, name: string) => {
  const value = Number(formats[name])
  if (!Number.isInteger(value)) throw new Error(`Seed format ${name} is not a number: ${formats[name]}`)
  return value
}

/**
 * The rendition tmux's `capture-pane -e` leaves active: it emits only
 * changes and carries them across lines. Tracked so every row break can be
 * made with the default rendition (a scrolling line feed fills the new row
 * with the current background) and the rendition restored after it.
 */
class Rendition {
  private fg = ''
  private bg = ''
  private underlineColour = ''
  private flags = new Map<string, string>()
  /** Follow every SGR sequence in `text`. */
  follow(text: string): void {
    for (let at = text.indexOf('\x1b['); at !== -1; at = text.indexOf('\x1b[', at + 2)) {
      let end = at + 2
      while (end < text.length && /[0-9;:]/.test(text[end]!)) end++
      if (text[end] === 'm') this.apply(text.slice(at + 2, end))
    }
  }
  private apply(sequence: string): void {
    const params = sequence === '' ? ['0'] : sequence.split(';')
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!
      const [code, sub] = param.split(':') as [string, string | undefined]
      const n = Number(code)
      if (n === 0) { this.fg = ''; this.bg = ''; this.underlineColour = ''; this.flags.clear() }
      else if (n === 38 || n === 48 || n === 58) {
        // Extended colour: 38;5;n / 38;2;r;g;b, or the colon form in one parameter.
        let value = param
        if (sub === undefined) {
          const mode = params[i + 1]
          const take = mode === '5' ? 2 : mode === '2' ? 4 : 0
          value = params.slice(i, i + 1 + take).join(';')
          i += take
        }
        if (n === 38) this.fg = value; else if (n === 48) this.bg = value; else this.underlineColour = value
      } else if (n === 39) this.fg = ''
      else if (n === 49) this.bg = ''
      else if (n === 59) this.underlineColour = ''
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) this.fg = param
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) this.bg = param
      else if (n === 22) { this.flags.delete('1'); this.flags.delete('2') }
      else if (n === 23) this.flags.delete('3')
      else if (n === 24) this.flags.delete('4')
      else if (n === 25) { this.flags.delete('5'); this.flags.delete('6') }
      else if (n >= 27 && n <= 29) this.flags.delete(String(n - 20))
      else if (n === 55) this.flags.delete('53')
      else if (n === 4 || n === 21) this.flags.set('4', n === 21 ? '4:2' : param)
      else this.flags.set(String(n), param)
    }
  }
  /** The tracked rendition as one SGR sequence ('' when default). */
  sgr(): string {
    const parts = [...this.flags.values(), this.fg, this.bg, this.underlineColour].filter(Boolean)
    return parts.length ? `\x1b[${parts.join(';')}m` : ''
  }
}

/**
 * One capture's rows joined with the default rendition at every break, the
 * carried rendition restored after it. Each capture starts from the default
 * rendition, so separate captures are joined with `blocks`.
 */
function rows(lines: string[]): string {
  const pen = new Rendition()
  let out = ''
  lines.forEach((line, i) => {
    if (i > 0) out += '\x1b[0m\r\n' + pen.sgr()
    out += line
    pen.follow(line)
  })
  return out + '\x1b[0m'
}
const blocks = (...captures: string[][]) => captures.filter((capture) => capture.length).map(rows).join('\r\n')

/**
 * The column a captured visual row leaves the cursor at: its characters'
 * widths, escape sequences skipped, tabs to the next stop.
 */
export function capturedRowWidth(row: string, cols: number, stops: number[]): number {
  let column = 0
  let text = ''
  const settle = () => { column += textWidth(text, profileWidths()); text = '' }
  for (let i = 0; i < row.length; i++) {
    const char = row[i]!
    if (char === '\x1b') {
      settle()
      const kind = row[i + 1]
      if (kind === '[') {
        // CSI: parameters up to the final byte.
        i += 2
        while (i < row.length && !/[@-~]/.test(row[i]!)) i++
      } else if (kind === ']') {
        // OSC (links): up to BEL or ST.
        i += 2
        while (i < row.length && row[i] !== '\x07' && !(row[i] === '\x1b' && row[i + 1] === '\\')) i++
        if (row[i] === '\x1b') i++
      } else i++
      continue
    }
    if (char === '\t') {
      settle()
      column = stops.find((stop) => stop > column) ?? cols - 1
      continue
    }
    text += char
  }
  settle()
  return Math.min(column, cols)
}

/** Turn the replies of `seedCommands` into seed bytes (pure). */
export function seedFrom(replies: string[][]): Seed {
  if (replies.length !== 5) throw new Error(`A seed needs 5 replies, got ${replies.length}`)
  const values = (replies[0]![0] ?? '').split('\t')
  if (values.length !== SEED_FORMATS.length) throw new Error('Seed formats are incomplete')
  const formats: Record<string, string> = Object.fromEntries(SEED_FORMATS.map((name, i) => [name, values[i]!]))
  const cols = number(formats, 'pane_width')
  const rows_ = number(formats, 'pane_height')
  const history = number(formats, 'history_size') > 0 ? replies[1]! : []
  const screen = replies[2]!
  const savedNormal = replies[3]!
  const visual = replies[4]!
  const cursorX = number(formats, 'cursor_x')
  const cursorY = number(formats, 'cursor_y')
  const upper = number(formats, 'scroll_region_upper')
  // RIS first: the seed describes a whole terminal. Tab stops before any
  // content (captured rows can hold literal tabs); the profile hands them to
  // the alternate buffer on every switch (patchSharedTabStops).
  const stops = formats.pane_tabs!.split(',').filter(Boolean).map(Number)
  const tabs = '\x1b[3g' + stops.map((stop) => `\x1b[1;${stop + 1}H\x1bH`).join('') + '\x1b[H'
  let seed = '\x1bc' + tabs
  if (formats.alternate_on === '1') {
    // History plus the saved normal screen form the normal buffer; the program's screen is the alternate one.
    // (A saved cursor in a pending wrap is placed on the last column.)
    seed += blocks(history, savedNormal)
    // (Clamped, as tmux restores it on leaving the alternate screen.)
    seed += `\x1b[${number(formats, 'alternate_saved_y') + 1};${Math.min(number(formats, 'alternate_saved_x'), cols - 1) + 1}H\x1b[?1049h\x1b[H\x1b[2J` + rows(screen)
  } else seed += blocks(history, screen)
  seed += `\x1b[${upper + 1};${number(formats, 'scroll_region_lower') + 1}r\x1b[0m`
  if (formats.keypad_cursor_flag === '1') seed += '\x1b[?1h'
  if (formats.keypad_flag === '1') seed += '\x1b='
  if (formats.bracket_paste_flag === '1') seed += '\x1b[?2004h'
  if (formats.focus_flag === '1') seed += '\x1b[?1004h'
  if (formats.mouse_any_flag === '1') seed += '\x1b[?1003h'
  else if (formats.mouse_button_flag === '1') seed += '\x1b[?1002h'
  else if (formats.mouse_standard_flag === '1') seed += '\x1b[?1000h'
  if (formats.mouse_sgr_flag === '1') seed += '\x1b[?1006h'
  if (formats.cursor_flag === '0') seed += '\x1b[?25l'
  const origin = formats.origin_flag === '1'
  if (origin) seed += '\x1b[?6h'
  const row = (origin ? cursorY - upper : cursorY) + 1
  if (cursorX >= cols) {
    // A pending wrap: the cursor sits past the last column. Print the
    // cursor's visual row again, filled to the width, which leaves xterm in
    // the same state.
    const pen = new Rendition()
    for (const line of visual.slice(0, cursorY)) pen.follow(line)
    const line = visual[cursorY] ?? ''
    // A row cleared after the wrap began is captured shorter: its blank
    // (default) cells are filled in, so the row ends at the last column.
    const blank = cols - capturedRowWidth(line, cols, stops)
    seed += `\x1b[${row};1H${pen.sgr()}${line}\x1b[0m${' '.repeat(Math.max(0, blank))}`
  } else seed += `\x1b[${row};${cursorX + 1}H`
  // Last, as they change how the reprint above prints: insert mode would
  // shift the row, and the pending wrap needs wraparound on.
  if (formats.insert_flag === '1') seed += '\x1b[4h'
  if (formats.wrap_flag === '0') seed += '\x1b[?7l'
  return { bytes: new TextEncoder().encode(seed), cols, rows: rows_ }
}

export const RESEED_ATTEMPTS = 5
/** The waits between attempts (one fewer than the attempts). */
export const RESEED_BACKOFF_MS = [100, 250, 500, 1000] as const

/**
 * Reseed `log` from tmux. The seed lands in the log at the group's final
 * reply, synchronously, before any later output is fed. Failures retry with
 * backoff (one capture in flight at a time, so memory never grows with
 * retries); after RESEED_ATTEMPTS the log is invalidated. Concurrent calls
 * for one log share the attempt in flight.
 */
export function reseed(control: ControlClient, log: OutputLog, target: string, reason: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<Seed> {
  const running = inFlight.get(log)
  if (running) return running
  const attempt = (async () => {
    let lastError: unknown
    for (let tried = 0; tried < RESEED_ATTEMPTS; tried++) {
      if (tried > 0) await sleep(RESEED_BACKOFF_MS[tried - 1]!)
      if (log.invalidReason) throw new Error(`Reseed abandoned: the log is invalid (${log.invalidReason})`)
      let seed: Seed | undefined
      try {
        await control.group(seedCommands(target), (replies) => {
          seed = seedFrom(replies)
          // A seed the log did not keep (no consumer, or it overflowed) is a failure.
          if (!log.seed(seed.bytes, seed.cols, seed.rows, reason)) throw new Error(`the log did not take the seed (${log.invalidReason ?? 'no consumer'})`)
        })
        return seed!
      } catch (error) {
        lastError = error
        // A closed connection will not answer a retry: recovery reattaches instead.
        if (control.isClosed) break
      }
    }
    log.invalidate(`reseed failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  })()
  inFlight.set(log, attempt)
  void attempt.finally(() => inFlight.delete(log)).catch(() => undefined)
  return attempt
}
const inFlight = new WeakMap<OutputLog, Promise<Seed>>()
