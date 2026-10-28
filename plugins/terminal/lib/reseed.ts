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

/** Pane state the seed restores, read in the same group as the captures. */
export const SEED_FORMATS = [
  'cursor_x', 'cursor_y', 'cursor_flag', 'keypad_cursor_flag', 'keypad_flag', 'insert_flag', 'origin_flag', 'wrap_flag',
  'bracket_paste_flag', 'mouse_standard_flag', 'mouse_button_flag', 'mouse_any_flag', 'mouse_sgr_flag', 'focus_flag',
  'scroll_region_upper', 'scroll_region_lower', 'alternate_on', 'alternate_saved_x', 'alternate_saved_y', 'pane_tabs',
  'history_size', 'pane_width', 'pane_height',
] as const

/**
 * The four commands of one seed: the formats, the newest history rows the
 * replica keeps, the screen, and (on the alternate screen) the saved normal
 * screen. Rows are captured with attributes (-e), wrapped lines joined (-J)
 * and trailing spaces kept (-N).
 */
export function seedCommands(target: string, history = TERMINAL_OPTIONS.scrollback): string[][] {
  return [
    ['display-message', '-p', '-t', target, SEED_FORMATS.map((name) => `#{${name}}`).join('\t')],
    // -E -1 clamps to row 0 when there is no history: history_size (same group) says whether this block is real.
    ['capture-pane', '-p', '-e', '-J', '-N', '-S', String(-history), '-E', '-1', '-t', target],
    ['capture-pane', '-p', '-e', '-J', '-N', '-S', '0', '-E', '-', '-t', target],
    ['capture-pane', '-p', '-e', '-J', '-N', '-a', '-q', '-t', target],
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

/** Turn the replies of `seedCommands` into seed bytes (pure). */
export function seedFrom(replies: string[][]): Seed {
  if (replies.length !== 4) throw new Error(`A seed needs 4 replies, got ${replies.length}`)
  const values = (replies[0]![0] ?? '').split('\t')
  if (values.length !== SEED_FORMATS.length) throw new Error('Seed formats are incomplete')
  const formats: Record<string, string> = Object.fromEntries(SEED_FORMATS.map((name, i) => [name, values[i]!]))
  const cols = number(formats, 'pane_width')
  const rows = number(formats, 'pane_height')
  const history = number(formats, 'history_size') > 0 ? replies[1]! : []
  const screen = replies[2]!
  const savedNormal = replies[3]!
  const cursorX = number(formats, 'cursor_x')
  const cursorY = number(formats, 'cursor_y')
  const upper = number(formats, 'scroll_region_upper')
  // RIS first: the seed describes a whole terminal.
  let seed = '\x1bc'
  if (formats.alternate_on === '1') {
    // History plus the saved normal screen form the normal buffer; the program's screen is the alternate one.
    seed += [...history, ...savedNormal].join('\r\n')
    seed += `\x1b[${number(formats, 'alternate_saved_y') + 1};${number(formats, 'alternate_saved_x') + 1}H\x1b[?1049h\x1b[H\x1b[2J` + screen.join('\r\n')
  } else seed += [...history, ...screen].join('\r\n')
  // Tab stops: clear all, then set tmux's.
  seed += '\x1b[3g' + formats.pane_tabs!.split(',').filter(Boolean).map((stop) => `\x1b[1;${Number(stop) + 1}H\x1bH`).join('')
  seed += `\x1b[${upper + 1};${number(formats, 'scroll_region_lower') + 1}r\x1b[0m\x1b[${cursorY + 1};${cursorX + 1}H`
  if (formats.keypad_cursor_flag === '1') seed += '\x1b[?1h'
  if (formats.keypad_flag === '1') seed += '\x1b='
  if (formats.insert_flag === '1') seed += '\x1b[4h'
  if (formats.wrap_flag === '0') seed += '\x1b[?7l'
  if (formats.bracket_paste_flag === '1') seed += '\x1b[?2004h'
  if (formats.focus_flag === '1') seed += '\x1b[?1004h'
  if (formats.mouse_any_flag === '1') seed += '\x1b[?1003h'
  else if (formats.mouse_button_flag === '1') seed += '\x1b[?1002h'
  else if (formats.mouse_standard_flag === '1') seed += '\x1b[?1000h'
  if (formats.mouse_sgr_flag === '1') seed += '\x1b[?1006h'
  if (formats.cursor_flag === '0') seed += '\x1b[?25l'
  // Origin mode positions relative to the region: set it, then place the cursor again.
  if (formats.origin_flag === '1') seed += `\x1b[?6h\x1b[${cursorY - upper + 1};${cursorX + 1}H`
  return { bytes: new TextEncoder().encode(seed), cols, rows }
}

export const RESEED_ATTEMPTS = 5
export const RESEED_BACKOFF_MS = [100, 250, 500, 1000, 2000] as const

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
      if (tried > 0) await sleep(RESEED_BACKOFF_MS[Math.min(tried - 1, RESEED_BACKOFF_MS.length - 1)]!)
      if (log.invalidReason) throw new Error(`Reseed abandoned: the log is invalid (${log.invalidReason})`)
      let seed: Seed | undefined
      try {
        await control.group(seedCommands(target), (replies) => {
          seed = seedFrom(replies)
          log.seed(seed.bytes, seed.cols, seed.rows, reason)
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
