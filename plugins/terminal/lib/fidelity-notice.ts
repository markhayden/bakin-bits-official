/**
 * The persistent notice a raw-path session shows once its picture was
 * rebuilt from tmux (spec D13 recovery contract, decision 1; plan T35a).
 * Pure and browser-safe: the page renders it with the kit Banner. Every
 * input is the session's server-held fidelity, so a reconnect or a later
 * checkpoint never clears it. The text names causes, never counts: the
 * Banner announces its whole text when it changes, and a flood rebuilds
 * every second, so it changes only when a new cause appears or the
 * history's state moves.
 */
import type { Fidelity } from './raw-display'
import type { UnavailableReason } from './socket'

export interface FidelityNotice { title: string; description: string }

const LIMITS = 'Formatting and terminal behavior may remain incorrect until the application resets or redraws.'

/** The causes, in words. */
function causes(fidelity: Fidelity): string[] {
  const named: string[] = []
  const { overload = 0, 'tail bound': tailBound = 0, width = 0 } = fidelity.rebuilds
  if (fidelity.recoveries) named.push("the view's connection to tmux was replaced")
  if (overload) named.push('output arrived faster than the view could follow')
  // The tail outgrew its bound before a checkpoint could be taken (by bytes, events or a state no checkpoint restores).
  if (tailBound) named.push('the view could not save a restorable copy of recent output in time')
  if (width) named.push('a width change could not be applied in place')
  return named
}

function history(fidelity: Fidelity): string {
  if (fidelity.history === 'incomplete') return ' Earlier output is shown again once output pauses.'
  if (fidelity.history === 'reloaded') return ' Earlier output was reloaded from tmux; some of it may still be missing.'
  return ''
}

/** The notice for a session's fidelity, or none while nothing was rebuilt. */
export function fidelityNotice(fidelity: Fidelity | undefined): FidelityNotice | undefined {
  if (!fidelity) return undefined
  const named = causes(fidelity)
  if (!named.length) return undefined
  const cause = ` Cause: ${named.join('; ')}.`
  // Overload alone has its own copy (decision 1); any other rebuild is a recovery.
  const overloadOnly = named.length === 1 && Boolean(fidelity.rebuilds.overload)
  if (overloadOnly) {
    return {
      title: 'Terminal view refreshed after high output',
      description: `High output caused the terminal view to refresh from tmux. Some output or terminal state may be missing. ${LIMITS}${history(fidelity)}${cause}`,
    }
  }
  return {
    title: 'Terminal view recovered with limitations',
    description: `Some earlier output may be missing or differ. ${LIMITS}${history(fidelity)}${cause}`,
  }
}

/** What an ended raw-path session shows instead of its output, by why there is none (plan T35b). */
export function unavailableNotice(reason: UnavailableReason): FidelityNotice {
  if (reason === 'evicted') return { title: 'Output removed', description: "This session's saved output was removed to stay within Terminal's storage limit. Session metadata is retained." }
  if (reason === 'unreadable') return { title: 'Output unavailable', description: "This session's saved output could not be read. Session metadata is retained." }
  return { title: 'Output not saved', description: 'This session ended without its output being saved. Session metadata is retained.' }
}
