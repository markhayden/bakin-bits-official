/**
 * The persistent notice a raw-path session shows once its picture was
 * rebuilt from tmux (spec D13 recovery contract, decision 1; plan T35a).
 * Pure and browser-safe: the page renders it with the kit Banner. Every
 * input is the session's server-held fidelity, so a reconnect or a later
 * checkpoint never clears it.
 */
import type { Fidelity } from './raw-display'

export interface FidelityNotice { title: string; description: string }

const LIMITS = 'Formatting and terminal behavior may remain incorrect until the application resets or redraws.'

const times = (count: number) => count === 1 ? 'once' : `${count} times`

/** The causes, in words, with how often each happened. */
function causes(fidelity: Fidelity): string[] {
  const named: string[] = []
  const { overload = 0, 'tail bound': tailBound = 0, width = 0 } = fidelity.rebuilds
  if (fidelity.recoveries) named.push(`the view's connection to tmux was replaced (${times(fidelity.recoveries)})`)
  if (overload) named.push(`output arrived faster than the view could follow (${times(overload)})`)
  if (tailBound) named.push(`a control sequence stayed unfinished too long to keep the view current (${times(tailBound)})`)
  if (width) named.push(`a width change could not be applied in place (${times(width)})`)
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
