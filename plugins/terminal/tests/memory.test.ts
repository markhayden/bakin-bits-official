import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import headless from '@xterm/headless'
import { EVENT_OVERHEAD_BYTES, MemoryWarning, RETAINED_CLEAR_BYTES, RETAINED_WARNING_BYTES, terminalBytes } from '../lib/memory'
import { MAX_TAIL_BYTES, MAX_TAIL_EVENTS } from '../lib/replica'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import type { Term } from '../lib/terminal-state'
import type { Measurement, Shape } from './helpers/memory-measure'

describe('MemoryWarning', () => {
  it('turns on past the warning with one log line, and off only below the clear line', () => {
    const lines: Record<string, unknown>[] = []
    const warning = new MemoryWarning({ warn: (_message, data) => { lines.push(data!) } })
    expect(warning.observe(RETAINED_WARNING_BYTES)).toBe(false)
    expect(warning.observe(RETAINED_WARNING_BYTES + 1)).toBe(true)
    expect(lines).toEqual([{ retainedBytes: RETAINED_WARNING_BYTES + 1, warningBytes: RETAINED_WARNING_BYTES }])
    // Between the lines it stays on, and says nothing more.
    expect(warning.observe(RETAINED_CLEAR_BYTES)).toBe(true)
    expect(warning.observe(RETAINED_WARNING_BYTES + 5e6)).toBe(true)
    expect(lines).toHaveLength(1)
    expect(warning.observe(RETAINED_CLEAR_BYTES - 1)).toBe(false)
    expect(warning.active).toBe(false)
    // A second crossing is a second warning.
    warning.observe(RETAINED_WARNING_BYTES + 1)
    expect(lines).toHaveLength(2)
  })
})

describe('terminalBytes', () => {
  it('grows with the lines and side maps both buffers hold', async () => {
    const terminal = new headless.Terminal({ cols: 80, rows: 10, ...TERMINAL_OPTIONS })
    applyTerminalProfile(terminal)
    const empty = terminalBytes(terminal)
    await write(terminal, 'plain\r\n'.repeat(100))
    const plain = terminalBytes(terminal)
    expect(plain).toBeGreaterThan(empty)
    await write(terminal, '\x1b]8;;https://example.com\x07linked\x1b]8;;\x07 👍🏽\r\n')
    expect(terminalBytes(terminal)).toBeGreaterThan(plain)
    const before = terminalBytes(terminal)
    await write(terminal, '\x1b[?1049h' + 'alt\r\n'.repeat(5))
    expect(terminalBytes(terminal)).toBeGreaterThan(before)
    terminal.dispose()
  })
})

// A local measurement (spec D13 memory budget, plan T32d) on Bun 1.4.3, each
// shape in a fresh process (tests/helpers/memory-measure.ts). Run with
// TERMINAL_MEMORY_TEST=1; it prints what it measured.
const measurement = process.env.TERMINAL_MEMORY_TEST === '1' ? it : it.skip
const MB = 1e6
const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`
async function measure(shape: Shape): Promise<Measurement> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/memory-measure.ts'), shape], { stdout: 'pipe', stderr: 'inherit' })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const result = JSON.parse(output) as Measurement
  console.log(`${shape}: measured ${mb(result.measured)}, estimated ${mb(result.estimate)}${result.peak === undefined ? '' : `, peak ${mb(result.peak)}`}`)
  return result
}
/** Within 25%, or 1 MB for a small reading (the emulator's own baseline dominates it). */
const close = ({ measured, estimate }: Measurement) => Math.abs(estimate - measured) <= Math.max(0.25 * measured, MB)

describe('memory budget (measured)', () => {
  measurement('the estimate follows the heap for every content shape, long strings and wide sessions included', async () => {
    for (const shape of ['coloured', 'linked', 'underlined', 'graphemes', 'long-links', 'long-graphemes', 'grapheme-replica', 'wide'] as const) {
      expect(close(await measure(shape)), shape).toBe(true)
    }
  }, 600000)

  measurement('retained: a replica at 120 × 10,000 rows of the reference workload, with its base and a full tail, is at most 32 MB', async () => {
    const result = await measure('replica')
    // The tail is bounded by construction (a longer one rebuilds): its bytes and its events.
    const tail = MAX_TAIL_BYTES + MAX_TAIL_EVENTS * EVENT_OVERHEAD_BYTES
    console.log(`replica with a full tail: at most ${mb(result.measured + tail)}`)
    expect(result.measured + tail).toBeLessThanOrEqual(32 * MB)
    expect(close(result)).toBe(true)
  }, 120000)

  measurement('peak: R1 shadow mode at a checkpoint attempt (replica, Screen, verifier, full queues, three joins) is at most 96 MB live', async () => {
    const { peak } = await measure('checkpoint-peak')
    expect(peak!).toBeLessThanOrEqual(96 * MB)
  }, 120000)

  measurement('resident memory through a checkpoint attempt and a rebuild seed is recorded, not gated', async () => {
    for (const shape of ['checkpoint-rss', 'reseed-peak'] as const) expect((await measure(shape)).peak!).toBeGreaterThan(0)
  }, 300000)
})

const write = (terminal: Term, text: string) => new Promise<void>((resolve) => terminal.write(text, resolve))
