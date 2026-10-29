import { describe, expect, it } from 'bun:test'
import { routeScroll } from '../components/scroll-route'

const fits = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 }
const tall = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 })
const live = (baseY: number) => ({ viewportY: baseY, baseY, alternate: false })
const cell = 20

describe('routeScroll (plan T36)', () => {
  it('a grid that fits: up scrolls the history by whole lines, carrying the remainder; down comes back to the live screen', () => {
    expect(routeScroll(-50, fits, live(100), cell)).toEqual({ pan: 0, lines: -2, carry: -10 })
    // The carried 10 px makes the next 10 px a line.
    expect(routeScroll(-10, fits, live(100), cell, -10)).toEqual({ pan: 0, lines: -1, carry: 0 })
    expect(routeScroll(60, fits, { viewportY: 90, baseY: 100, alternate: false }, cell)).toEqual({ pan: 0, lines: 3, carry: 0 })
  })
  it('history at its boundaries: never above its top, never below the live screen', () => {
    expect(routeScroll(-400, fits, { viewportY: 3, baseY: 100, alternate: false }, cell)).toEqual({ pan: 0, lines: -3, carry: 0 })
    expect(routeScroll(400, fits, { viewportY: 98, baseY: 100, alternate: false }, cell)).toEqual({ pan: 0, lines: 2, carry: 0 })
    expect(routeScroll(-40, fits, live(0), cell)).toEqual({ pan: 0, lines: 0, carry: 0 })
  })
  it('an overflowing grid with history: up pans to its top first, then the history; down leaves the history, then pans', () => {
    expect(routeScroll(-100, tall(60), live(100), cell)).toEqual({ pan: -60, lines: -2, carry: 0 })
    expect(routeScroll(-100, tall(200), live(100), cell)).toEqual({ pan: -100, lines: 0, carry: 0 })
    // In history at the grid's top: down returns to the live screen (2 lines), the rest pans.
    expect(routeScroll(70, tall(0), { viewportY: 98, baseY: 100, alternate: false }, cell)).toEqual({ pan: 30, lines: 2, carry: 0 })
    expect(routeScroll(900, tall(500), live(100), cell)).toEqual({ pan: 100, lines: 0, carry: 0 })
  })
  it('the alternate screen has no history: it only pans', () => {
    expect(routeScroll(-100, tall(60), { viewportY: 0, baseY: 0, alternate: true }, cell)).toEqual({ pan: -60, lines: 0, carry: 0 })
    expect(routeScroll(-100, fits, { viewportY: 50, baseY: 50, alternate: true }, cell)).toEqual({ pan: 0, lines: 0, carry: 0 })
  })
})
