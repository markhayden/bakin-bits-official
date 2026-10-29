import { describe, expect, it } from 'bun:test'
import { programSteps, routeScroll } from '../components/scroll-route'

const fits = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 }
const tall = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 })
const live = (baseY: number) => ({ viewportY: baseY, baseY, alternate: false })
const at = (viewportY: number, baseY = 100) => ({ viewportY, baseY, alternate: false })
const cell = 20

describe('routeScroll (plan T36)', () => {
  it('a grid that fits: up scrolls the history by whole lines, carrying the remainder; down comes back to the live screen', () => {
    expect(routeScroll(-50, fits, live(100), cell)).toEqual({ pan: 0, lines: -2, carry: -10 })
    // The carried 10 px makes the next 10 px a line.
    expect(routeScroll(-10, fits, live(100), cell, -10)).toEqual({ pan: 0, lines: -1, carry: 0 })
    expect(routeScroll(60, fits, at(90), cell)).toEqual({ pan: 0, lines: 3, carry: 0 })
  })
  it('history at its boundaries: never above its top, never below the live screen', () => {
    expect(routeScroll(-400, fits, at(3), cell)).toEqual({ pan: 0, lines: -3, carry: 0 })
    expect(routeScroll(400, fits, at(98), cell)).toEqual({ pan: 0, lines: 2, carry: 0 })
    expect(routeScroll(-40, fits, live(0), cell)).toEqual({ pan: 0, lines: 0, carry: 0 })
  })
  it('the remainder never carries past a boundary, nor across a reversal', () => {
    // One line left: -39 px reaches the top exactly; nothing carries.
    expect(routeScroll(-39, fits, at(1), cell)).toEqual({ pan: 0, lines: -1, carry: 0 })
    // An exact whole-line match at the boundary carries nothing either.
    expect(routeScroll(-40, fits, at(2), cell)).toEqual({ pan: 0, lines: -2, carry: 0 })
    // Reversing drops an upward remainder: a full row down moves a full line.
    expect(routeScroll(20, fits, at(50), cell, -19)).toEqual({ pan: 0, lines: 1, carry: 0 })
    expect(routeScroll(-20, fits, at(50), cell, 19)).toEqual({ pan: 0, lines: -1, carry: 0 })
  })
  it('an overflowing grid with history: the history first in either direction, then the pan', () => {
    // Up from the live screen, panned down: the history moves, the pane stays.
    expect(routeScroll(-100, tall(200), live(100), cell)).toEqual({ pan: 0, lines: -5, carry: 0 })
    // At the history's top the rest pans up.
    expect(routeScroll(-100, tall(200), at(2), cell)).toEqual({ pan: -60, lines: -2, carry: 0 })
    expect(routeScroll(-100, tall(200), at(0), cell)).toEqual({ pan: -100, lines: 0, carry: 0 })
    // Down: out of the history to the live screen (2 lines), the rest pans.
    expect(routeScroll(70, tall(0), at(98), cell)).toEqual({ pan: 30, lines: 2, carry: 0 })
    expect(routeScroll(900, tall(500), live(100), cell)).toEqual({ pan: 100, lines: 0, carry: 0 })
  })
  it('the alternate screen has no history: it only pans', () => {
    expect(routeScroll(-100, tall(60), { viewportY: 0, baseY: 0, alternate: true }, cell)).toEqual({ pan: -60, lines: 0, carry: 0 })
    expect(routeScroll(-100, fits, { viewportY: 50, baseY: 50, alternate: true }, cell)).toEqual({ pan: 0, lines: 0, carry: 0 })
  })
})

describe('programSteps (a program that scrolls itself: one report per row)', () => {
  it('fractional rows lose no report (400 px over 15 rows, three lines at a time)', () => {
    const cell = 400 / 15
    let carry = 0
    let total = 0
    for (let n = 0; n < 5; n++) { const step = programSteps(-3 * cell, cell, carry); total += step.steps; carry = step.carry }
    expect(total).toBe(-15)
    expect(carry).toBe(0)
  })
  it('reversing keeps nothing of the other direction, and loses nothing either', () => {
    const cell = 400 / 15
    let carry = 0
    let total = 0
    for (let n = 0; n < 10; n++) { const step = programSteps((n % 2 ? 3 : -3) * cell, cell, carry); total += Math.abs(step.steps); carry = step.carry }
    expect(total).toBe(30)
  })
  it('a partial row carries to the next event in the same direction', () => {
    expect(programSteps(-15, 20)).toEqual({ steps: 0, carry: -0.75 })
    expect(programSteps(-10, 20, -0.75)).toEqual({ steps: -1, carry: -0.25 })
    expect(programSteps(10, 20, -0.75)).toEqual({ steps: 0, carry: 0.5 })
  })
})
