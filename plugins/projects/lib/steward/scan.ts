/**
 * The scan gate (D20, D20a): given a project and its digest, should a
 * steward task be created now? Pure — reservation, reconcile and the daily
 * cap live in reservation.ts and run around this.
 */
import type { Project } from '../../types'
import type { StewardDigest } from './digest'

export type StewardSkipReason =
  | 'not_active'
  | 'paused'
  | 'waiting_on_user'
  | 'completion_pending'
  | 'run_open'
  | 'no_signals'
  | 'unchanged'

export type StewardDecision =
  | { run: true; reason: 'changed' | 're-raise' | 'forced' }
  | { run: false; reason: StewardSkipReason }

/** A pending `complete` sign-off owns the project until it is decided (D26). */
export function completionPending(project: Project): boolean {
  return Object.entries(project.gates ?? {}).some(([key, gate]) => key.startsWith('complete:') && gate.state === 'pending')
}

/**
 * Projects the loop may look at: Active, not paused, not waiting on the
 * user's answer (or its reply turn), no completion sign-off pending, and no
 * steward run already open (one at a time).
 */
export function stewardEligibility(project: Project): StewardSkipReason | null {
  if (project.status !== 'active') return 'not_active'
  if (project.stewardPaused) return 'paused'
  if (project.waitingOn || project.replyPending) return 'waiting_on_user'
  if (completionPending(project)) return 'completion_pending'
  if (project.steward?.openTaskId) return 'run_open'
  return null
}

export interface DecideOptions {
  now: Date
  stuckAfterMs: number
  /** Start's hand-off (D27): bypass the fingerprint gate once — even with no signals. */
  force?: boolean
}

export function decideStewardRun(project: Project, digest: StewardDigest, opts: DecideOptions): StewardDecision {
  const ineligible = stewardEligibility(project)
  if (ineligible) return { run: false, reason: ineligible }
  if (opts.force) return { run: true, reason: 'forced' }
  if (digest.signals.length === 0) return { run: false, reason: 'no_signals' }
  const steward = project.steward
  if (digest.fingerprint !== steward?.lastFingerprint) return { run: true, reason: 'changed' }
  // Same unresolved situation: one re-raise per window since the last run.
  const last = steward?.lastStewardAt ? Date.parse(steward.lastStewardAt) : NaN
  if (!Number.isFinite(last) || opts.now.getTime() - last >= opts.stuckAfterMs) return { run: true, reason: 're-raise' }
  return { run: false, reason: 'unchanged' }
}
