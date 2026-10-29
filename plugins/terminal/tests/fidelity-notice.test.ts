import { describe, expect, it } from 'bun:test'
import { fidelityNotice } from '../lib/fidelity-notice'

const LIMITS = 'Formatting and terminal behavior may remain incorrect until the application resets or redraws.'

describe('fidelityNotice (spec D13 recovery contract, decision 1)', () => {
  it('shows nothing while nothing was rebuilt', () => {
    expect(fidelityNotice(undefined)).toBeUndefined()
    expect(fidelityNotice({ rebuilds: {} })).toBeUndefined()
    expect(fidelityNotice({ rebuilds: {}, recoveries: 0 })).toBeUndefined()
  })
  it('a lost replica rebuilt from tmux: D13\'s copy, the cause named', () => {
    expect(fidelityNotice({ rebuilds: {}, recoveries: 1 })).toEqual({
      title: 'Terminal view recovered with limitations',
      description: `Some earlier output may be missing or differ. ${LIMITS} Cause: the view's connection to tmux was replaced (once).`,
    })
  })
  it('overload alone has its own copy, with where the history stands', () => {
    expect(fidelityNotice({ rebuilds: { overload: 3 }, lastCause: 'overload', history: 'incomplete' })).toEqual({
      title: 'Terminal view refreshed after high output',
      description: `High output caused the terminal view to refresh from tmux. Some output or terminal state may be missing. ${LIMITS} Earlier output is shown again once output pauses. Cause: output arrived faster than the view could follow (3 times).`,
    })
    expect(fidelityNotice({ rebuilds: { overload: 1 }, history: 'reloaded' })!.description)
      .toContain('Earlier output was reloaded from tmux; some of it may still be missing.')
  })
  it('any other rebuild is a recovery, every cause listed', () => {
    const notice = fidelityNotice({ rebuilds: { overload: 1, 'tail bound': 2, width: 1 }, recoveries: 1 })!
    expect(notice.title).toBe('Terminal view recovered with limitations')
    expect(notice.description).toEndWith("Cause: the view's connection to tmux was replaced (once); output arrived faster than the view could follow (once); a control sequence stayed unfinished too long to keep the view current (2 times); a width change could not be applied in place (once).")
  })
})
