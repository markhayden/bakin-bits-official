/**
 * An ended session's final output (spec D13, plan T35b):
 * the replica's last cut — its accepted checkpoint, the bounded tail after
 * it and the sequence boundary — with the final dimensions, the profile and
 * format versions, and the session's fidelity (recovery metadata). An ended
 * session is shown from it through the same join a live one gets
 * (`bundleSource`).
 *
 * Stored as a small header and many small parts (checkpoint pieces of at
 * most RESTORE_STEP_CHARS, one tail event each), so writing and reading it
 * are sliced work, never one encode of a whole picture that can be a
 * hundred megabytes (lib/store.ts).
 */
import { z } from 'zod'
import packageJson from '../package.json'
import { CHECKPOINT_FORMAT, pieces, type Checkpoint } from './checkpoint'
import type { LogEvent } from './output-log'
import type { Fidelity } from './raw-display'
import type { Cut, ReplicaListener, ReplicaState } from './replica'

/** Bumped whenever the stored fields change meaning; another format is never decoded. */
export const BUNDLE_FORMAT = 1
/**
 * The terminal profile's identity: the pinned xterm release (both sides,
 * architecture-tested). A behaviour change under the same pin bumps
 * BUNDLE_FORMAT instead.
 */
export const PROFILE = `xterm ${packageJson.dependencies['@xterm/headless']}`

export interface Bundle {
  format: typeof BUNDLE_FORMAT
  profile: string
  cut: Cut
  /** The size the session ended at (the checkpoint's, then every layout or geometry in the tail). */
  cols: number
  rows: number
  fidelity: Fidelity
  savedAt: number
}

/** The cut's size after its tail. */
export function finalSize(cut: Cut): { cols: number; rows: number } {
  let { cols, rows } = cut.checkpoint
  for (const event of cut.tail) if (event.kind === 'layout' || event.kind === 'geometry') ({ cols, rows } = event)
  return { cols, rows }
}

export function makeBundle(cut: Cut, fidelity: Fidelity, savedAt: number): Bundle {
  return { format: BUNDLE_FORMAT, profile: PROFILE, cut, ...finalSize(cut), fidelity, savedAt }
}

/** One stored part: a checkpoint piece (text), or a tail event (its fields, and its bytes if it has them). */
export type BundlePart = { kind: 'piece'; text: string } | { kind: 'event'; event: Omit<LogEvent, 'bytes'>; bytes?: Uint8Array }

/** Everything but the checkpoint's text and the tail: small, stored as JSON. */
export function bundleHeader(bundle: Bundle): string {
  const { data: _data, ...checkpoint } = bundle.cut.checkpoint
  return JSON.stringify({ ...bundle, cut: { checkpoint, baseSeq: bundle.cut.baseSeq, throughSeq: bundle.cut.throughSeq, history: bundle.cut.history } })
}

/** The parts, in order (one step each: the store writes them sliced). */
export function* bundleParts(bundle: Bundle): Generator<BundlePart> {
  for (const text of pieces(bundle.cut.checkpoint.data)) yield { kind: 'piece', text }
  for (const event of bundle.cut.tail) {
    if ('bytes' in event) {
      const { bytes, ...fields } = event
      yield { kind: 'event', event: fields, bytes }
    } else yield { kind: 'event', event }
  }
}

const size = z.number().int().positive()
const seq = z.number().int().nonnegative()
const bytes = z.instanceof(Uint8Array)
/** Every tail event a replay can meet, checked before one is streamed (a stored row can be damaged). */
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ seq, kind: z.literal('output'), offset: z.number().int().nonnegative(), bytes }),
  z.object({ seq, kind: z.literal('layout'), cols: size, rows: size }),
  z.object({ seq, kind: z.literal('seed'), bytes, cols: size, rows: size, reason: z.string(), history: z.boolean() }),
  z.object({ seq, kind: z.literal('geometry'), bytes, cols: size, rows: size, generation: z.number().int(), history: z.boolean() }),
])
const headerSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  profile: z.string(),
  cols: size, rows: size, savedAt: z.number(),
  fidelity: z.object({ rebuilds: z.record(z.string(), z.number()), lastCause: z.string().optional(), history: z.enum(['incomplete', 'reloaded']).optional(), recoveries: z.number().optional() }),
  cut: z.object({
    baseSeq: seq, throughSeq: seq, history: z.boolean(),
    checkpoint: z.object({ format: z.literal(CHECKPOINT_FORMAT), cols: size, rows: size, scrollback: z.number().int().nonnegative() }).passthrough(),
  }),
})

/**
 * The bundle from its header and parts, or undefined when it is another
 * format, profile or checkpoint format, or malformed in any field a replay
 * reads (nothing is guessed at).
 */
export function assembleBundle(header: string, parts: Iterable<BundlePart>): Bundle | undefined {
  try {
    const stored = headerSchema.safeParse(JSON.parse(header))
    if (!stored.success || stored.data.profile !== PROFILE) return undefined
    const data: string[] = []
    const tail: LogEvent[] = []
    for (const part of parts) {
      if (part.kind === 'piece') { if (typeof part.text !== 'string') return undefined; data.push(part.text); continue }
      const event = eventSchema.safeParse(part.bytes ? { ...part.event, bytes: part.bytes } : part.event)
      if (!event.success) return undefined
      tail.push(event.data as LogEvent)
    }
    const { cut, ...rest } = stored.data
    return { ...rest, fidelity: rest.fidelity as Fidelity, cut: { ...cut, checkpoint: { ...cut.checkpoint, data } as unknown as Checkpoint, tail } }
  } catch {
    // A malformed row reads as no bundle: the session shows its output as unavailable.
    return undefined
  }
}

/** A finished picture as a replica source: always the same cut, never another event. */
export function bundleSource(bundle: Bundle): { state(): ReplicaState; subscribe(listener: ReplicaListener): { state: ReplicaState; unsubscribe(): void } } {
  const state: ReplicaState = { kind: 'live', cut: bundle.cut }
  return { state: () => state, subscribe: () => ({ state, unsubscribe: () => undefined }) }
}
