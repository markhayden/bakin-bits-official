import { describe, expect, it } from 'bun:test'
import { Joystick, REPEAT_DELAY_MS, REPEAT_EVERY_MS, stickDirection, tapDirection } from '../components/joystick'
import type { Scheduler } from '../components/modifier-input'

function clock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const time: Scheduler = {
    set: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout> },
    clear: (timer) => { timers.delete(timer as unknown as number) },
  }
  const run = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].fn()
    }
    now = end
  }
  return { time, run, pending: () => timers.size }
}
function stick() {
  const sent: string[] = []
  const { time, run, pending } = clock()
  return { stick: new Joystick((key) => sent.push(key), time), sent, run, pending }
}

describe('stick direction', () => {
  it('is nothing inside the dead zone, else the dominant axis', () => {
    expect(stickDirection(5, 5, undefined)).toBeUndefined()
    expect(stickDirection(20, 3, undefined)).toBe('Right')
    expect(stickDirection(-3, -20, undefined)).toBe('Up')
    expect(stickDirection(2, 30, undefined)).toBe('Down')
  })
  it('resists flipping on a diagonal wobble (hysteresis)', () => {
    expect(stickDirection(20, 22, 'Right')).toBe('Right')
    expect(stickDirection(20, 30, 'Right')).toBe('Down')
  })
})

describe('tap direction', () => {
  it('a tap off-centre steps toward that edge; the centre does nothing', () => {
    expect(tapDirection(22, 20, 44, 40)).toBeUndefined()
    expect(tapDirection(40, 20, 44, 40)).toBe('Right')
    expect(tapDirection(22, 2, 44, 40)).toBe('Up')
    expect(tapDirection(3, 22, 44, 40)).toBe('Left')
  })
})

describe('joystick', () => {
  it('sends one step on entering a direction, repeats after a delay while held, and stops on release', () => {
    const { stick: s, sent, run, pending } = stick()
    s.start(100, 100)
    s.move(100, 80)
    expect(sent).toEqual(['Up'])
    run(REPEAT_DELAY_MS - 1)
    expect(sent).toEqual(['Up'])
    run(1 + REPEAT_EVERY_MS * 2)
    expect(sent).toEqual(['Up', 'Up', 'Up', 'Up'])
    expect(s.end(0, 0, 44, 40)).toBe(true)
    run(1000)
    expect(sent).toHaveLength(4)
    expect(pending()).toBe(0)
  })
  it('turning sends the new direction at once and restarts the delay; back to the centre pauses', () => {
    const { stick: s, sent, run } = stick()
    s.start(0, 0)
    s.move(30, 0)
    s.move(5, 3)
    run(REPEAT_DELAY_MS * 2)
    expect(sent).toEqual(['Right'])
    s.move(0, 30)
    expect(sent).toEqual(['Right', 'Down'])
    run(REPEAT_DELAY_MS)
    expect(sent).toEqual(['Right', 'Down', 'Down'])
  })
  it('a tap (no drag) steps toward the tapped edge', () => {
    const { stick: s, sent } = stick()
    s.start(50, 50)
    expect(s.end(40, 20, 44, 40)).toBe(true)
    expect(sent).toEqual(['Right'])
  })
  it('cancel stops everything and sends nothing more', () => {
    const { stick: s, sent, run, pending } = stick()
    s.start(0, 0)
    s.move(-30, 0)
    s.cancel()
    run(2000)
    expect(sent).toEqual(['Left'])
    expect(pending()).toBe(0)
    expect(s.end(0, 0, 44, 40)).toBe(false)
  })
})
