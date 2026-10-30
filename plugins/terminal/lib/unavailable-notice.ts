/**
 * What an ended raw-path session shows instead of its output, by why there
 * is none (plan T35b). Pure and browser-safe. (Recoveries of a live view are
 * quiet: the persistent recovery notice was removed at acceptance, Mark
 * 2026-10-29 — it was noise; the session's fidelity is still kept.)
 */
import type { UnavailableReason } from './socket'

export interface UnavailableNotice { title: string; description: string }

export function unavailableNotice(reason: UnavailableReason): UnavailableNotice {
  if (reason === 'evicted') return { title: 'Output removed', description: "This session's saved output was removed to stay within Terminal's storage limit. Session metadata is retained." }
  if (reason === 'unreadable') return { title: 'Output unavailable', description: "This session's saved output could not be read. Session metadata is retained." }
  return { title: 'Output not saved', description: 'This session ended without its output being saved. Session metadata is retained.' }
}
