/**
 * Where a vertical scroll goes in the terminal pane (spec D10, plan T36):
 * the pane pans the grid when it overflows, and xterm's history scrolls when
 * there is history. Scrolling up pans to the grid's top first, then goes
 * back into the history; scrolling down comes out of the history to the
 * live screen first, then pans down. The alternate screen has no history:
 * it only pans. Pure, so the wheel and touch paths share it (and tests).
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
 * (so slow trackpad motion still moves whole lines), `cell` the row height.
 */
export function routeScroll(delta: number, pane: PaneScroll, history: HistoryScroll, cell: number, carry = 0): ScrollRoute {
  const panUp = pane.scrollTop
  const panDown = Math.max(0, pane.scrollHeight - pane.clientHeight - pane.scrollTop)
  const historyUp = history.alternate ? 0 : history.viewportY
  const historyDown = history.alternate ? 0 : history.baseY - history.viewportY
  if (delta < 0) {
    // Up: the grid's top first, then the history.
    // (No -0: at the grid's top there is nothing to pan.)
    const pan = Math.max(delta, -panUp) || 0
    const rest = delta - pan
    if (rest < 0 && historyUp > 0) return toLines(pan, rest + carry, cell, historyUp, 0)
    return { pan, lines: 0, carry: 0 }
  }
  if (delta > 0) {
    const rest = delta
    // Down: out of the history first, then the grid.
    if (historyDown > 0) {
      const pixels = rest + carry
      const lines = Math.min(historyDown, Math.trunc(pixels / cell))
      if (lines < historyDown) return { pan: 0, lines, carry: pixels - lines * cell }
      // Back at the live screen: what is left pans.
      return { pan: Math.min(pixels - lines * cell, panDown), lines, carry: 0 }
    }
    return { pan: Math.min(rest, panDown), lines: 0, carry: 0 }
  }
  return { pan: 0, lines: 0, carry }
}

/** Pixels into whole lines within the history's bounds; the remainder carries (but never past a bound). */
function toLines(pan: number, pixels: number, cell: number, up: number, down: number): ScrollRoute {
  const whole = Math.trunc(pixels / cell)
  const lines = Math.max(-up, Math.min(down, whole)) || 0
  const carry = lines === whole ? pixels - whole * cell : 0
  return { pan, lines, carry }
}
