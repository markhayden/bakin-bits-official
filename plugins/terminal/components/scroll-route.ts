/**
 * Where a vertical scroll goes in the terminal pane (spec D10, plan T36):
 * xterm's history scrolls when there is history to scroll in that direction,
 * and the pane pans the grid otherwise (where it overflows). Up goes back
 * into the history until its top, then pans; down comes out of the history
 * to the live screen, then pans. The alternate screen has no history: it
 * only pans. Pure, so the wheel and touch paths share it (and tests).
 */

export interface PaneScroll { scrollTop: number; scrollHeight: number; clientHeight: number }
/** xterm's active buffer: where its viewport is, and how much history is above the screen. */
export interface HistoryScroll { viewportY: number; baseY: number; alternate: boolean }

export interface ScrollRoute {
  /** Pixels to scroll the pane by (negative: up). */
  pan: number
  /** Whole history lines to scroll xterm by (negative: up), and the pixel remainder carried to the next event. */
  lines: number
  carry: number
}

/**
 * `delta` in pixels (negative: up), `carry` the remainder of the last event
 * (so slow trackpad motion still moves whole lines; dropped when the
 * direction reverses), `cell` the row height.
 */
export function routeScroll(delta: number, pane: PaneScroll, history: HistoryScroll, cell: number, carry = 0): ScrollRoute {
  if (!delta) return { pan: 0, lines: 0, carry }
  const up = delta < 0
  // Lines of history in this direction, as a signed bound.
  const bound = history.alternate ? 0 : up ? -history.viewportY : history.baseY - history.viewportY
  const panBy = (pixels: number) => (up ? Math.max(pixels, -pane.scrollTop) : Math.min(pixels, Math.max(0, pane.scrollHeight - pane.clientHeight - pane.scrollTop))) || 0
  if (!bound) return { pan: panBy(delta), lines: 0, carry: 0 }
  const pixels = delta + (Math.sign(carry) === Math.sign(delta) ? carry : 0)
  const whole = Math.trunc(pixels / cell)
  // Short of the boundary: whole lines, the remainder carried.
  if (Math.abs(whole) < Math.abs(bound)) return { pan: 0, lines: whole || 0, carry: pixels - whole * cell }
  // At the boundary: what is left pans (nothing carries past it).
  return { pan: panBy(pixels - bound * cell), lines: bound, carry: 0 }
}

