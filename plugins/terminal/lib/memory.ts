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
import { drain, internals, type Term } from './terminal-state'

/** xterm's objects per line beyond its cell array (BufferLine, its side maps, the array header). */
export const LINE_OVERHEAD_BYTES = 512
/** An emulator before its lines: the core, its services and the profile's handlers. */
export const TERMINAL_BASE_BYTES = 1_000_000
/** One combined character beyond its text (a grapheme cluster's string in its line's map). */
export const COMBINED_ENTRY_BYTES = 172
/** One cell's entry in its line's extended-attribute map (links, underline styles and colours). */
export const EXTENDED_ENTRY_BYTES = 38
/** One extended-attribute object (cells of one run share theirs). */
export const EXTENDED_OBJECT_BYTES = 18
/** One link in the emulator's registry beyond its strings (the entry, its data and map slots). */
export const LINK_ENTRY_BYTES = 200
/** One line marker keeping a link alive. */
export const LINK_MARKER_BYTES = 120
/** One queued or tail event beyond its bytes (the event object and its byte view). */
export const EVENT_OVERHEAD_BYTES = 160

const WIDE = /[\u0100-\uffff]/
/** A string's own storage: JavaScriptCore keeps Latin-1 text in a byte a character and any other in two. */
export const stringBytes = (text: string): number => text.length * (WIDE.test(text) ? 2 : 1)

interface LineMaps { _data: Uint32Array; _combined: Record<number, string>; _extendedAttrs: Record<number, unknown> }
interface LinkEntries { _dataByLinkId: Map<number, { key?: string; data: { uri: string; id?: string }; lines: unknown[] }> }

/**
 * The bytes an emulator holds: every line's cell array (its capacity),
 * objects and side maps, and the link registry. Steps: one per line (run it
 * sliced, lib/replica.ts runSliced, or drained). Lines read across steps may
 * move (the buffer trims as it is written); an estimate, never a view.
 */
export function* terminalSteps(terminal: Term): Generator<void, number> {
  const core = internals(terminal)
  let total = TERMINAL_BASE_BYTES
  for (const buffer of [core.buffers.normal, core.buffers.alt]) {
    for (let y = 0; y < buffer.lines.length; y++) {
      const line = buffer.lines.get(y) as unknown as LineMaps | undefined
      if (!line) continue
      total += line._data.byteLength + LINE_OVERHEAD_BYTES
      for (const x in line._combined) total += COMBINED_ENTRY_BYTES + stringBytes(line._combined[x]!)
      let objects: Set<unknown> | undefined
      for (const x in line._extendedAttrs) {
        total += EXTENDED_ENTRY_BYTES
        ;(objects ??= new Set()).add(line._extendedAttrs[x])
      }
      if (objects) total += objects.size * EXTENDED_OBJECT_BYTES
      yield
    }
  }
  const links = (core as unknown as { _oscLinkService: LinkEntries })._oscLinkService._dataByLinkId
  for (const entry of links.values()) {
    total += LINK_ENTRY_BYTES + entry.lines.length * LINK_MARKER_BYTES + stringBytes(entry.data.uri) + (entry.data.id ? stringBytes(entry.data.id) : 0) + (entry.key ? stringBytes(entry.key) : 0)
    yield
  }
  return total
}
export const terminalBytes = (terminal: Term): number => drain(terminalSteps(terminal))

const TEXT_STEP = 65536
const textCache = new WeakMap<readonly string[], number>()
/** What retained text holds (stringBytes, a step per 64K characters; slices share their source). Cached: a checkpoint's data never changes. */
export function* textSteps(chunks: readonly string[]): Generator<void, number> {
  const cached = textCache.get(chunks)
  if (cached !== undefined) return cached
  let bytes = 0
  for (const chunk of chunks) {
    for (let at = 0; at < chunk.length; at += TEXT_STEP) {
      bytes += stringBytes(chunk.slice(at, at + TEXT_STEP))
      yield
    }
  }
  textCache.set(chunks, bytes)
  return bytes
}
export const textBytes = (chunks: readonly string[]): number => drain(textSteps(chunks))

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
