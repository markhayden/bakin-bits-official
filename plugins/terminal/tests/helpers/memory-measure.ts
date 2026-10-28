/**
 * One memory measurement in a fresh process (tests/memory.test.ts): the heap
 * after GC before and after building one shape, and the estimate for it.
 * Prints `{ measured, estimate }` in bytes as JSON. A process of its own so
 * no earlier measurement's garbage is still being collected.
 */
import { heapStats } from 'bun:jsc'
import headless from '@xterm/headless'
import { restoreCheckpoint } from '../../lib/checkpoint'
import { terminalBytes } from '../../lib/memory'
import { BATCH_BYTES, MAX_QUEUED_BYTES, type LogEvent } from '../../lib/output-log'
import { MAX_TAIL_BYTES, Replica } from '../../lib/replica'
import { Screen } from '../../lib/screen'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../../lib/terminal-profile'
import type { Term } from '../../lib/terminal-state'

export type Shape = 'coloured' | 'linked' | 'underlined' | 'graphemes' | 'replica' | 'peak' | 'wide'

const coloured = (i: number) => `\x1b[3${i % 8}mline ${i} ${'lorem ipsum dolor sit amet '.repeat(3)}\x1b[0m\r\n`
const LINES: Record<'coloured' | 'linked' | 'underlined' | 'graphemes', (i: number) => string> = {
  coloured,
  linked: (i) => `\x1b]8;;https://example.com/${i}\x07${'x'.repeat(100)}\x1b]8;;\x07\r\n`,
  underlined: (i) => Array.from({ length: 100 }, (_, x) => `\x1b[4;58:2::${x}:${i % 256}:0mx`).join('') + '\x1b[0m\r\n',
  graphemes: () => `${'👍🏽'.repeat(50)}\r\n`,
}

function heap(): number {
  Bun.gc(true)
  const stats = heapStats()
  // heapSize already counts extraMemorySize (typed arrays, string buffers).
  return stats.heapSize
}
function profiled(cols: number, rows: number): Term {
  const terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
  applyTerminalProfile(terminal)
  return terminal
}
async function write(terminal: Term, text: string): Promise<void> {
  for (let at = 0; at < text.length; at += 65536) await new Promise<void>((resolve) => terminal.write(text.slice(at, at + 65536), resolve))
}
/** Full scrollback: the 10,000 rows and the screen above them. */
function lines(line: (i: number) => string, rows = 40): string {
  let text = ''
  for (let i = 0; i < TERMINAL_OPTIONS.scrollback + rows; i++) text += line(i)
  return text
}
function events(bytes: number): LogEvent[] {
  return Array.from({ length: Math.ceil(bytes / BATCH_BYTES) }, (_, i) => ({ seq: i + 1, kind: 'output', offset: i * BATCH_BYTES, bytes: new Uint8Array(BATCH_BYTES).fill(0x61) }))
}
async function replica(text: string, cols: number, rows: number): Promise<Replica> {
  const r = new Replica({ reseed: (_reason, turn) => turn(async () => undefined), idleMs: 1e9 })
  await r.event({ seq: 1, kind: 'seed', bytes: new TextEncoder().encode(text), cols, rows, reason: 'measure' })
  await r.idle()
  return r
}

const keep: unknown[] = []
async function measure(shape: Shape): Promise<{ measured: number; estimate: number }> {
  if (shape in LINES) {
    // Built before the baseline: the text is not what is measured.
    const text = lines(LINES[shape as keyof typeof LINES])
    const before = heap()
    const terminal = profiled(120, 40)
    await write(terminal, text)
    keep.push(terminal)
    return { measured: heap() - before, estimate: terminalBytes(terminal) }
  }
  if (shape === 'wide') {
    const text = lines((i) => Array.from({ length: 400 }, (_, x) => `\x1b[38;2;${x % 256};${i % 256};0mx`).join('') + '\x1b[0m\r\n', 150)
    const before = heap()
    const r = await replica(text, 400, 150)
    keep.push(r)
    return { measured: heap() - before, estimate: r.retainedBytes() }
  }
  const text = lines(coloured)
  const before = heap()
  const r = await replica(text, 120, 40)
  keep.push(r)
  if (shape === 'replica') return { measured: heap() - before, estimate: r.retainedBytes() }
  // Peak (R1 shadow mode): the bridge Screen holds the same session, a
  // checkpoint's verifier restores one more terminal from the base, the log
  // queue and the tail are full, and three joins hold their own tail lists.
  const screen = new Screen(120, 40)
  const bytes = new TextEncoder().encode(text)
  for (let at = 0; at < bytes.length; at += BATCH_BYTES) await screen.write(bytes.subarray(at, at + BATCH_BYTES))
  const verifier = profiled(120, 40)
  await restoreCheckpoint(verifier, r.joinPoint()!.checkpoint)
  const tail = events(MAX_TAIL_BYTES)
  keep.push(screen, verifier, events(MAX_QUEUED_BYTES), tail, tail.slice(), tail.slice(), tail.slice())
  return { measured: heap() - before, estimate: r.retainedBytes() + screen.retainedBytes() + terminalBytes(verifier) + MAX_QUEUED_BYTES + MAX_TAIL_BYTES }
}

console.log(JSON.stringify(await measure(process.argv[2] as Shape)))
