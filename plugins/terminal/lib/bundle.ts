/**
 * An ended session's final output on the raw path (spec D13, plan T35b):
 * the replica's last cut — its accepted checkpoint, the bounded tail after
 * it and the sequence boundary — with the final dimensions, the profile and
 * format versions, and the session's fidelity (recovery metadata). Stored
 * as one row, written atomically; an ended raw-path session is shown from
 * it through the same join a live one gets (`bundleSource`).
 */
import packageJson from '../package.json'
import { CHECKPOINT_FORMAT, type Checkpoint } from './checkpoint'
import type { LogEvent } from './output-log'
import type { Fidelity } from './raw-display'
import type { Cut, ReplicaListener, ReplicaState } from './replica'

/** Bumped whenever the stored fields change meaning; another format is never decoded. */
export const BUNDLE_FORMAT = 1
/** The terminal profile's identity: the pinned xterm release (both sides, architecture-tested). */
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

type Stored = Omit<Bundle, 'cut'> & { cut: Omit<Cut, 'tail'> & { tail: Array<Omit<LogEvent, 'bytes'> & { bytes?: string }> } }

export function encodeBundle(bundle: Bundle): Uint8Array {
  const stored: Stored = {
    ...bundle,
    cut: { ...bundle.cut, tail: bundle.cut.tail.map((event) => 'bytes' in event ? { ...event, bytes: Buffer.from(event.bytes).toString('base64') } : event) },
  }
  return new TextEncoder().encode(JSON.stringify(stored))
}

/** The bundle, or undefined when it is another format or profile (nothing is guessed at). */
export function decodeBundle(data: Uint8Array): Bundle | undefined {
  const stored = JSON.parse(new TextDecoder().decode(data)) as Stored
  if (stored.format !== BUNDLE_FORMAT || stored.profile !== PROFILE || stored.cut.checkpoint.format !== CHECKPOINT_FORMAT) return undefined
  const tail = stored.cut.tail.map((event) => (event.bytes === undefined ? event : { ...event, bytes: new Uint8Array(Buffer.from(event.bytes, 'base64')) }) as LogEvent)
  return { ...stored, cut: { ...stored.cut, checkpoint: stored.cut.checkpoint as Checkpoint, tail } }
}

/** A finished picture as a replica source: always the same cut, never another event. */
export function bundleSource(bundle: Bundle): { state(): ReplicaState; subscribe(listener: ReplicaListener): { state: ReplicaState; unsubscribe(): void } } {
  const state: ReplicaState = { kind: 'live', cut: bundle.cut }
  return { state: () => state, subscribe: () => ({ state, unsubscribe: () => undefined }) }
}
