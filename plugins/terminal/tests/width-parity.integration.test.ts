import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import headless from '@xterm/headless'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'

// Spec D13: the replica and every viewer must lay text out on tmux's grid.
// Each sample is printed into a real tmux 3.7c pane and into a profiled
// emulator; the cursor column after it is the width each side gave it.
// Run with the managed pin: TERMINAL_PROCESS_TEST=1 TERMINAL_TMUX=~/.bakin/bin/tmux.
const processTest = process.env.TERMINAL_PROCESS_TEST === '1' ? test : test.skip

/** Laid out alike by tmux and the profile (emoji sequences included). */
const AGREE = [
  'a', 'é', '😃', '中文', '한국어', 'ｱ', 'Ａ', 'ﾃｽﾄ', '𠮷', '…', '€', '⌘', '✔', '☺',
  '👍🏽', '👨‍👩‍👧', '🧑‍💻', '🇺🇸', '❤️', '#️⃣', '✅ done', '⚠️ warn', '🚀🔥',
]
/**
 * Where they still differ (sample → [tmux, profile] widths). Rare in agent
 * output; the digest safety net rebases a viewer that drifts. Each entry
 * fails once either side changes, so it is re-examined then.
 */
const DIVERGE: [string, number, number][] = [
  // Default-ignorable format characters: tmux gives them no cell.
  ['x​y', 2, 3], ['x‎y', 2, 3], ['x⁠y', 2, 3],
  // Emoji newer than the addon's Unicode 15 table (Unicode 14+ additions it lacks, 15.1/16).
  ['🫠', 2, 1], ['\u{1FA75}', 2, 1], ['\u{1FAE8}', 2, 1],
  // tmux forces these emoji modifier bases wide.
  ['☝', 2, 1], ['✌', 2, 1],
  // Unicode 16 made the trigrams wide; the addon's table is Unicode 15.
  ['☰', 2, 1],
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
