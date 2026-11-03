import type { ArrowKey } from './terminal-input'
import type { Scheduler } from './modifier-input'

const realTime: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) }

/** Movement under this many px from the press point is no direction yet. */
export const DEAD_ZONE_PX = 12
/** Leaving the current direction needs the other axis this much larger (no flip-flop on a diagonal). */
export const HYSTERESIS = 1.25
export const REPEAT_DELAY_MS = 350
export const REPEAT_EVERY_MS = 100
/** A tap this close to the key's centre is no direction. */
export const TAP_CENTRE_PX = 6

const horizontal = (dx: number): ArrowKey => (dx < 0 ? 'Left' : 'Right')
const vertical = (dy: number): ArrowKey => (dy < 0 ? 'Up' : 'Down')

/** The direction a drag of (dx, dy) points, holding `current` until another axis clearly wins. */
export function stickDirection(dx: number, dy: number, current: ArrowKey | undefined): ArrowKey | undefined {
  if (Math.hypot(dx, dy) < DEAD_ZONE_PX) return undefined
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (current === 'Left' || current === 'Right') return ay > ax * HYSTERESIS ? vertical(dy) : horizontal(dx)
  if (current === 'Up' || current === 'Down') return ax > ay * HYSTERESIS ? horizontal(dx) : vertical(dy)
  return ax >= ay ? horizontal(dx) : vertical(dy)
}

/** Where a tap at (x, y) inside a `width`×`height` key points: toward the nearer edge, nothing at the centre. */
export function tapDirection(x: number, y: number, width: number, height: number): ArrowKey | undefined {
  const dx = x - width / 2, dy = y - height / 2
  if (Math.hypot(dx, dy) < TAP_CENTRE_PX) return undefined
  return Math.abs(dx) / width >= Math.abs(dy) / height ? horizontal(dx) : vertical(dy)
}

/**
 * The arrow joystick on the key bar (spec D9 item 9): press and drag to
 * send arrows (a step on entering a direction, repeating while held), or tap
 * an edge for one step. One pointer at a time; cancel ends it silently.
 */
export class Joystick {
  private origin: { x: number; y: number } | undefined
  private direction: ArrowKey | undefined
  private dragged = false
  private repeat: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly send: (key: ArrowKey) => void, private readonly time: Scheduler = realTime) {}

  get active(): boolean { return this.origin !== undefined }

  start(x: number, y: number) {
    this.stop()
    this.origin = { x, y }
    this.direction = undefined
    this.dragged = false
  }

  move(x: number, y: number) {
    if (!this.origin) return
    const next = stickDirection(x - this.origin.x, y - this.origin.y, this.direction)
    if (next) this.dragged = true
    if (next === this.direction) return
    this.time.clear(this.repeat)
    this.direction = next
    if (!next) return
    this.send(next)
    const again = (delay: number) => { this.repeat = this.time.set(() => { this.send(next); again(REPEAT_EVERY_MS) }, delay) }
    again(REPEAT_DELAY_MS)
  }

  /** Release at (x, y) inside the `width`×`height` key; true if this press was the joystick's (suppress the click). */
  end(x: number, y: number, width: number, height: number): boolean {
    if (!this.origin) return false
    const tap = !this.dragged
    this.stop()
    if (tap) {
      const step = tapDirection(x, y, width, height)
      if (step) this.send(step)
    }
    return true
  }

  /** Pointer cancelled, capture lost, unmount or disabled: stop without sending. */
  cancel() { this.stop() }

  private stop() {
    this.time.clear(this.repeat)
    this.repeat = undefined
    this.origin = undefined
    this.direction = undefined
  }
}
