import { describe, expect, it } from 'bun:test'
import { keyboardUp, occluded } from '../components/keyboard-state'

// A 390×844 phone; the on-screen keyboard covers ~300 px of it.
const open = { layoutHeight: 844, visualHeight: 544, visualTop: 0, scale: 1 }
const closed = { layoutHeight: 844, visualHeight: 844, visualTop: 0, scale: 1 }

describe('keyboard detection', () => {
  it('measures what the visual viewport leaves uncovered at the bottom', () => {
    expect(occluded(open)).toBe(300)
    // Safari scrolls the page as the keyboard opens: the covered strip is still at the bottom.
    expect(occluded({ ...open, visualTop: 120 })).toBe(180)
  })
  it('is up only while the terminal has focus and the keyboard covers enough of the screen', () => {
    expect(keyboardUp(false, open, true)).toBe(true)
    expect(keyboardUp(false, open, false)).toBe(false)
    expect(keyboardUp(true, closed, true)).toBe(false)
    // A hardware keyboard covers nothing: no bar.
    expect(keyboardUp(false, closed, true)).toBe(false)
  })
  it('has hysteresis, so a toolbar collapsing or a small viewport wobble does not flicker the bar', () => {
    const toolbar = { ...closed, visualHeight: 844 - 110 }
    expect(keyboardUp(false, toolbar, true)).toBe(false)
    expect(keyboardUp(true, toolbar, true)).toBe(true)
  })
  it('ignores samples taken while the page is pinch-zoomed', () => {
    const zoomed = { layoutHeight: 844, visualHeight: 300, visualTop: 200, scale: 2.5 }
    expect(keyboardUp(false, zoomed, true)).toBe(false)
    expect(keyboardUp(true, zoomed, true)).toBe(true)
  })
  it('shows the bar whenever the terminal has focus when the viewport cannot be measured', () => {
    expect(keyboardUp(false, undefined, true)).toBe(true)
    expect(keyboardUp(true, undefined, false)).toBe(false)
  })
})
