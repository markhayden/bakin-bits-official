import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import headless from '@xterm/headless'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import { renderTmuxWidthTable } from '../scripts/generate-tmux-widths'

// Spec D13: the replica and every viewer must lay text out on tmux's grid.
// Each sample is printed into a real tmux 3.7c pane and into a profiled
// emulator; the cursor column after it is the width each side gave it.
// Run with the managed pin: TERMINAL_PROCESS_TEST=1 TERMINAL_TMUX=~/.bakin/bin/tmux.
const processTest = process.env.TERMINAL_PROCESS_TEST === '1' ? test : test.skip

/** Laid out alike by tmux and the profile (emoji sequences and the generated widths included). */
const AGREE = [
  'a', 'e\u0301', '😃', '中文', '한국어', '각', 'ｱ', 'Ａ', 'ﾃｽﾄ', '𠮷', '…', '€', '⌘', '✔', '☺', '⌚', 'ไทย', '\u0915\u094d\u0937',
  '👍🏽', '👨\u200d👩\u200d👧', '🧑\u200d💻', '🧑🏽\u200d💻', '🇺🇸', '🇺🇸🇬', '❤\ufe0f', '↔\ufe0f', '©\ufe0f', '#\ufe0f\u20e3', '✅ done', '⚠️ warn', '🚀🔥',
  // From the generated table: format characters, tmux's force-wide bases, newer emoji, Unicode 16 widths.
  'x\u200by', 'x\u200ey', 'x\u2060y', '☝', '✌', '🫠', '\u{1FA75}', '\u{1FAE8}', '☰',
  // Zero-width marks the grapheme rules would widen the previous cell for.
  '\uff76\u3099', 'a\u302a',
  // An escape between two regional indicators: tmux and the grapheme rules both pair them.
  '🇺\x1b[0m🇸',
]
/**
 * What tmux combines by context, which a width provider cannot mirror
 * (sample → [tmux, profile] widths). Each fails once either side changes.
 * Rare in agent output; T37 compares the replica's cursor with tmux's.
 */
const DIVERGE: [string, number, number][] = [
  // A skin tone after a letter: tmux gives it its own wide cell; the grapheme rules attach it.
  ['a\u{1F3FD}', 3, 2],
  // Thai SARA AM: tmux spaces it; the grapheme rules join it to its consonant.
  ['\u0e01\u0e33', 2, 1],
  // tmux discards the Hangul filler and a jungseong filler with nothing to compose with.
  ['x\u3164y', 2, 4], ['a\u1160', 1, 2],
  // tmux combines with the cell left of the cursor across escapes; xterm's join state resets.
  ['👍\x1b[1m🏽', 2, 4],
]

let tmux = ''
let socket = ''
let root = ''
const run = (...args: string[]) => {
  const result = Bun.spawnSync([tmux, '-S', socket, '-f', '/dev/null', ...args], { env: { PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } })
  return result.stdout.toString().trim()
}
const settle = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20) }

beforeAll(async () => {
  if (process.env.TERMINAL_PROCESS_TEST !== '1') return
  tmux = process.env.TERMINAL_TMUX ?? Bun.which('tmux') ?? ''
  if (!tmux) throw new Error('TERMINAL_PROCESS_TEST needs tmux: set TERMINAL_TMUX to the managed binary')
  root = mkdtempSync(join(tmpdir(), 'bakin-terminal-width-'))
  socket = join(root, 'tmux.sock')
  // A raw `cat` echoes each sample back, as a program printing it would.
  run('new-session', '-d', '-s', 'w', '-x', '200', '-y', '5', 'stty raw -echo; exec cat')
  await settle(() => run('display', '-p', '-t', 'w', '#{pane_current_command}') === 'cat')
})
afterAll(() => {
  if (!root) return
  run('kill-server')
  rmSync(root, { recursive: true, force: true })
})

async function widths(sample: string): Promise<[number, number]> {
  run('send-keys', '-t', 'w', 'C-m')
  await settle(() => run('display', '-p', '-t', 'w', '#{cursor_x}') === '0')
  run('send-keys', '-t', 'w', '-l', sample)
  // The echo lands asynchronously: wait until the cursor stops moving.
  let last = ''
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(20)
    const now = run('display', '-p', '-t', 'w', '#{cursor_x}')
    if (now === last && now !== '0') break
    last = now
  }
  const emulator = new headless.Terminal({ cols: 200, rows: 5, ...TERMINAL_OPTIONS })
  applyTerminalProfile(emulator)
  await new Promise<void>(resolve => emulator.write(sample, resolve))
  const x = emulator.buffer.active.cursorX
  emulator.dispose()
  return [Number(run('display', '-p', '-t', 'w', '#{cursor_x}')), x]
}

describe('character widths: the profile against tmux 3.7c', () => {
  processTest('the generated width table is what this tmux measures (regenerate it when this fails)', () => {
    expect(renderTmuxWidthTable(tmux)).toBe(readFileSync(join(import.meta.dir, '../lib/tmux-width-table.ts'), 'utf8'))
  }, 60000)
  processTest('emoji, CJK and grapheme sequences take the cells tmux gives them', async () => {
    for (const sample of AGREE) {
      const [inTmux, inProfile] = await widths(sample)
      expect(inProfile, JSON.stringify(sample)).toBe(inTmux)
    }
  }, 30000)
  processTest('the known divergences are still exactly these', async () => {
    for (const [sample, tmuxWidth, profileWidth] of DIVERGE) {
      expect(await widths(sample), JSON.stringify(sample)).toEqual([tmuxWidth, profileWidth])
    }
  }, 30000)
})
