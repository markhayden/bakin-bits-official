/**
 * One memory measurement in a fresh process (tests/memory.test.ts), so no
 * earlier measurement's garbage is still being collected. Prints JSON in
 * bytes: `measured` (heap after GC, after minus before), `estimate` (what
 * lib/memory.ts says), and for a lifecycle phase `peak`: what was resident
 * before it plus how far resident memory rose while it ran.
 * `heapStats().heapSize` already counts typed arrays and string buffers.
 */
import { heapStats } from 'bun:jsc'
import headless from '@xterm/headless'
import { checkpointSteps, type CheckpointResult } from '../../lib/checkpoint'
import { terminalBytes } from '../../lib/memory'
import { BATCH_BYTES, MAX_QUEUED_BYTES, type LogEvent } from '../../lib/output-log'
import { CHECKPOINT_BYTES, MAX_TAIL_BYTES, Replica } from '../../lib/replica'
import { Screen } from '../../lib/screen'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../../lib/terminal-profile'
import { drain, type Term } from '../../lib/terminal-state'

export type Shape = 'coloured' | 'linked' | 'underlined' | 'graphemes' | 'long-links' | 'long-graphemes'
  | 'replica' | 'grapheme-replica' | 'wide' | 'checkpoint-peak' | 'checkpoint-rss' | 'reseed-peak'
export interface Measurement { measured: number; estimate: number; peak?: number }

const coloured = (i: number) => `\x1b[3${i % 8}mline ${i} ${'lorem ipsum dolor sit amet '.repeat(3)}\x1b[0m\r\n`
const graphemes = () => `${'👍🏽'.repeat(50)}\r\n`
const TERMINALS: Record<string, (i: number) => string> = {
  coloured,
  linked: (i) => `\x1b]8;;https://example.com/${i}\x07${'x'.repeat(100)}\x1b]8;;\x07\r\n`,
  underlined: (i) => Array.from({ length: 100 }, (_, x) => `\x1b[4;58:2::${x}:${i % 256}:0mx`).join('') + '\x1b[0m\r\n',
  graphemes,
}

const heapNow = () => heapStats().heapSize
const rssNow = () => process.memoryUsage.rss()
function heap(): number {
  Bun.gc(true)
  return heapNow()
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
function lines(line: (i: number) => string, rows = 40, from = 0): string {
  let text = ''
  for (let i = from; i < from + TERMINAL_OPTIONS.scrollback + rows; i++) text += line(i)
  return text
}
function outputEvents(bytes: Uint8Array, seq: number): LogEvent[] {
  const events: LogEvent[] = []
  for (let at = 0; at < bytes.length; at += BATCH_BYTES) events.push({ seq: seq++, kind: 'output', offset: at, bytes: bytes.subarray(at, at + BATCH_BYTES) })
  return events
}
function filler(bytes: number): LogEvent[] {
  return Array.from({ length: Math.ceil(bytes / BATCH_BYTES) }, (_, i) => ({ seq: i + 1, kind: 'output', offset: i * BATCH_BYTES, bytes: new Uint8Array(BATCH_BYTES).fill(0x61) }))
}
const encode = (text: string) => new TextEncoder().encode(text)
async function seeded(text: string, cols = 120, rows = 40): Promise<Replica> {
  const r = new Replica({ reseed: (_reason, turn) => turn(async () => undefined), idleMs: 1e9 })
  await r.event({ seq: 1, kind: 'seed', bytes: encode(text), cols, rows, reason: 'measure' })
  await r.idle()
  return r
}
/**
 * How far the process's resident memory rose while `run` ran, sampled every
 * millisecond (the heap size is only exact after a collection; resident
 * memory is what the machine pays, garbage and allocator slack included).
 */
async function risen(run: () => Promise<void>): Promise<number> {
  const start = rssNow()
  let high = start
  const timer = setInterval(() => { high = Math.max(high, rssNow()) }, 1)
  try { await run() } finally { clearInterval(timer) }
  return Math.max(high, rssNow()) - start
}

const keep: unknown[] = []
async function measure(shape: Shape): Promise<Measurement> {
  if (shape === 'long-links' || shape === 'long-graphemes') {
    // Built and written after the baseline and dropped before the reading:
    // what the terminal keeps of the text (its own strings, or slices that
    // keep a chunk of it alive) is what is measured.
    const before = heap()
    const terminal = profiled(120, 40)
    await write(terminal, shape === 'long-links'
      ? Array.from({ length: 100 }, (_, i) => `\x1b]8;;https://example.com/${i}/${'p'.repeat(100_000)}\x07x\x1b]8;;\x07\r\n`).join('')
      : Array.from({ length: 100 }, () => `a${'\u0301'.repeat(100_000)}\r\n`).join(''))
    keep.push(terminal)
    return { measured: heap() - before, estimate: terminalBytes(terminal) }
  }
  if (shape in TERMINALS) {
    // Built before the baseline: the text is not what is measured.
    const text = lines(TERMINALS[shape]!)
    const before = heap()
    const terminal = profiled(120, 40)
    await write(terminal, text)
    keep.push(terminal)
    return { measured: heap() - before, estimate: terminalBytes(terminal) }
  }
  if (shape === 'wide' || shape === 'grapheme-replica') {
    const [text, cols, rows] = shape === 'wide'
      ? [lines((i) => Array.from({ length: 400 }, (_, x) => `\x1b[38;2;${x % 256};${i % 256};0mx`).join('') + '\x1b[0m\r\n', 150), 400, 150] as const
      : [lines(graphemes), 120, 40] as const
    const before = heap()
    const r = await seeded(text, cols, rows)
    keep.push(r)
    return { measured: heap() - before, estimate: drain(r.retainedSteps()) }
  }
  const text = lines(coloured)
  // Just past CHECKPOINT_BYTES of further output: one attempt.
  const more = encode(lines(coloured, 2000, 20_000)).subarray(0, CHECKPOINT_BYTES + BATCH_BYTES)
  const before = heap()
  const r = await seeded(text)
  keep.push(r)
  if (shape === 'replica') return { measured: heap() - before, estimate: drain(r.retainedSteps()) }
  // R1 shadow mode: the bridge Screen holds the same session and the log queue is full.
  const screen = new Screen(120, 40)
  const bytes = encode(text)
  for (let at = 0; at < bytes.length; at += BATCH_BYTES) await screen.write(bytes.subarray(at, at + BATCH_BYTES))
  keep.push(screen, filler(MAX_QUEUED_BYTES))
  if (shape === 'checkpoint-peak') {
    // The live high-water: a tail just short of an attempt and three joins
    // of it held, then one checkpoint attempt (serialize, verify in a scratch
    // terminal, compare) stepped by hand with the heap read after a
    // collection every 250 steps. The rest of a full tail is added (bounded).
    for (const event of outputEvents(more.subarray(0, CHECKPOINT_BYTES - BATCH_BYTES), 2)) await r.event(event)
    await r.idle()
    keep.push([r.joinPoint(), r.joinPoint(), r.joinPoint()])
    const steps = checkpointSteps(r.terminal!)
    let high = heap()
    let result: CheckpointResult | undefined
    for (let n = 1; ; n++) {
      const next = steps.next()
      if (next.done) { result = next.value; break }
      if (n % 250 === 0) high = Math.max(high, heap())
    }
    if (!result || 'rejected' in result) throw new Error(`expected an accepted checkpoint, got ${JSON.stringify(result)}`)
    keep.push(result)
    high = Math.max(high, heap())
    return { measured: heap() - before, estimate: drain(r.retainedSteps()) + drain(screen.retainedSteps()) + MAX_QUEUED_BYTES, peak: high - before + MAX_TAIL_BYTES - r.tailSize }
  }
  if (shape === 'checkpoint-rss') {
    // What the machine pays for the same attempt run by the replica itself
    // (output past CHECKPOINT_BYTES): resident memory, garbage included.
    const events = outputEvents(more, 2)
    const joins: unknown[] = []
    const resident = heap() - before
    const rise = await risen(async () => {
      for (const event of events) {
        await r.event(event)
        if (joins.length < 3) joins.push(r.joinPoint())
      }
      await r.idle()
    })
    if (r.stats.accepted !== 1) throw new Error(`expected one accepted checkpoint, got ${JSON.stringify(r.stats)}`)
    keep.push(joins)
    return { measured: heap() - before, estimate: drain(r.retainedSteps()) + drain(screen.retainedSteps()) + MAX_QUEUED_BYTES, peak: resident + rise + MAX_TAIL_BYTES }
  }
  // reseed-peak: a rebuild's seed (capture reply bytes, decoded text, the replacement terminal) over the old replica.
  const seed: LogEvent = { seq: 2, kind: 'seed', bytes: encode(text), cols: 120, rows: 40, reason: 'measure' }
  const resident = heap() - before
  const rise = await risen(async () => { await r.event(seed); await r.idle() })
  return { measured: heap() - before, estimate: drain(r.retainedSteps()) + drain(screen.retainedSteps()) + MAX_QUEUED_BYTES, peak: resident + rise }
}

console.log(JSON.stringify(await measure(process.argv[2] as Shape)))
// What was measured is still held (a replica's idle timer among it): end here.
process.exit(0)
