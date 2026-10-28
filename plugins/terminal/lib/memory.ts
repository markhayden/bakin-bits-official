/**
 * What a session's emulators hold in memory, estimated from their
 * structure (spec D13 memory budget, plan T32d) — never by serializing or
 * measuring the heap at runtime. Calibrated on Bun 1.4.3 (M4) against the
 * heap after GC (`heapStats().heapSize`, which already counts typed arrays
 * and string buffers): one profile terminal at 120 × (10,000 + 40) rows of
 * coloured text is 19.6 MB (cell arrays 14.5 MB, xterm's per-line objects,
 * about 1 MB of emulator); side maps were measured with every cell linked,
 * every cell distinctly underlined, and emoji graphemes. tests/memory.test.ts
 * holds the estimate within 25% of each (it is within 6%). */
import { internals, type Term } from './terminal-state'

/** xterm's objects per line beyond its cell array (BufferLine, its side maps, the array header). */
export const LINE_OVERHEAD_BYTES = 512
/** An emulator before its lines: the core, its services and the profile's handlers. */
export const TERMINAL_BASE_BYTES = 1_000_000
/** One combined character (a grapheme cluster's string in its line's map). */
export const COMBINED_ENTRY_BYTES = 180
/** One cell's entry in its line's extended-attribute map (links, underline styles and colours). */
export const EXTENDED_ENTRY_BYTES = 38
/** One extended-attribute object (cells of one run share theirs). */
export const EXTENDED_OBJECT_BYTES = 18

interface LineMaps { _data: Uint32Array; _combined: Record<number, string>; _extendedAttrs: Record<number, unknown> }

/** The bytes an emulator's buffers hold: every line's cell array (its capacity), objects and side maps. */
export function terminalBytes(terminal: Term): number {
  const core = internals(terminal)
  let total = TERMINAL_BASE_BYTES
  for (const buffer of [core.buffers.normal, core.buffers.alt]) {
    for (let y = 0; y < buffer.lines.length; y++) {
      const line = buffer.lines.get(y) as unknown as LineMaps | undefined
      if (!line) continue
      total += line._data.byteLength + LINE_OVERHEAD_BYTES
      for (const _ in line._combined) total += COMBINED_ENTRY_BYTES
      let objects: Set<unknown> | undefined
      for (const x in line._extendedAttrs) {
        total += EXTENDED_ENTRY_BYTES
        ;(objects ??= new Set()).add(line._extendedAttrs[x])
      }
      if (objects) total += objects.size * EXTENDED_OBJECT_BYTES
    }
  }
  return total
}

/** One queued or tail event beyond its bytes (the event object and its byte view). */
export const EVENT_OVERHEAD_BYTES = 160

const WIDE = /[\u0100-\uffff]/
const textCache = new WeakMap<readonly string[], number>()
/**
 * What retained text holds: JavaScriptCore keeps a string of Latin-1
 * characters in a byte each and any other in two (slices share their
 * source). Cached per chunk list: a checkpoint's data never changes.
 */
export function textBytes(chunks: readonly string[]): number {
  let bytes = textCache.get(chunks)
  if (bytes === undefined) {
    bytes = 0
    for (const chunk of chunks) bytes += chunk.length * (WIDE.test(chunk) ? 2 : 1)
    textCache.set(chunks, bytes)
  }
  return bytes
}
/** Above this total of live sessions' retained memory, the server warns (20 sessions at the 32 MB ceiling). */
export const RETAINED_WARNING_BYTES = 640 * 1000 * 1000
/** The warning clears again below this (a little under, so it does not flap). */
export const RETAINED_CLEAR_BYTES = 600 * 1000 * 1000

/**
 * The memory warning (spec D13): on as live sessions' retained total passes
 * RETAINED_WARNING_BYTES (one server log line then), off again only below
 * RETAINED_CLEAR_BYTES. Health shows it while it is on.
 */
export class MemoryWarning {
  private on = false
  constructor(private log?: { warn(message: string, data?: Record<string, unknown>): void }) {}
  get active(): boolean { return this.on }
  /** Take a reading of the retained total; returns whether the warning is on. */
  observe(retainedBytes: number): boolean {
    const on = this.on ? retainedBytes >= RETAINED_CLEAR_BYTES : retainedBytes > RETAINED_WARNING_BYTES
    if (on && !this.on) this.log?.warn('Terminal sessions are holding a lot of memory', { retainedBytes, warningBytes: RETAINED_WARNING_BYTES })
    this.on = on
    return on
  }
}
