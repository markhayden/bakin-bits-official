import { describe, expect, it } from 'bun:test'
import { COMPOSITION_COMMIT_MS, ModifierInput, type Scheduler } from '../components/modifier-input'
import type { ModifierState } from '../components/terminal-input'

/** A hand-cranked clock: `run(ms)` fires every timer due by then, in order. */
function clock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const time: Scheduler = {
    set: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout> },
    clear: (timer) => { timers.delete(timer as unknown as number) },
  }
  const run = (ms: number) => {
    now += ms
    for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(key); timer.fn() }
  }
  return { time, run }
}
function setup() {
  const seen: ModifierState[] = []
  const { time, run } = clock()
  const input = new ModifierInput(state => seen.push(state), time)
  return { input, run, seen }
}

describe('modifier input', () => {
  it('applies a one-shot modifier to the next keystroke only', () => {
    const { input, run } = setup()
    input.toggle('ctrl')
    input.userEvent()
    expect(input.data('c')).toBe('\x03')
    expect(input.modifiers.ctrl).toBe('off')
    input.userEvent()
    expect(input.data('c')).toBe('c')
    run(0)
  })
  it('sends bar keys already encoded, never applying a lock twice', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    const sent: string[] = []
    input.key('Left', false, bytes => sent.push(input.data(bytes)))
    expect(sent).toEqual(['\x1b[1;5D'])
    expect(input.modifiers.ctrl).toBe('locked')
  })
  it('leaves xterm\'s own replies alone: a focus report neither changes nor consumes a modifier', () => {
    const { input, run } = setup()
    input.toggle('ctrl')
    run(10)
    expect(input.data('\x1b[O')).toBe('\x1b[O')
    expect(input.data('\x1b[12;3R')).toBe('\x1b[12;3R')
    expect(input.modifiers.ctrl).toBe('once')
    const sent: string[] = []
    input.key('Left', false, bytes => sent.push(input.data(bytes)))
    expect(sent).toEqual(['\x1b[1;5D'])
  })
  it('marks only the current task as the operator\'s', () => {
    const { input, run } = setup()
    input.toggle('alt', 'lock')
    input.userEvent()
    run(0)
    expect(input.data('b')).toBe('b')
  })
  it('sends an IME commit as typed even after compositionend (xterm delivers it later), under a lock', () => {
    const { input, run } = setup()
    input.toggle('ctrl', 'lock')
    input.compositionStart()
    input.compositionEnd('c')
    run(1)
    // xterm's deferred read delivers the commit from a timer: no keystroke in between.
    expect(input.data('c')).toBe('c')
    // The commit ended the composition: the next keystroke takes the lock again.
    input.userEvent()
    expect(input.data('c')).toBe('\x03')
  })
  it('gives up waiting for a commit that never comes', () => {
    const { input, run } = setup()
    input.toggle('ctrl', 'lock')
    input.compositionStart()
    input.compositionEnd('c')
    run(COMPOSITION_COMMIT_MS + 1)
    input.userEvent()
    expect(input.data('c')).toBe('\x03')
  })
  it('composition and paste clear a one-shot modifier and keep a lock', () => {
    const { input } = setup()
    input.toggle('ctrl')
    input.toggle('alt', 'lock')
    input.compositionStart()
    expect(input.modifiers).toEqual({ ctrl: 'off', alt: 'locked' })
    input.compositionEnd('c')
    input.toggle('ctrl')
    input.paste()
    expect(input.modifiers).toEqual({ ctrl: 'off', alt: 'locked' })
  })
  it('reset releases locks; clearOnce keeps them', () => {
    const { input, seen } = setup()
    input.toggle('ctrl', 'lock')
    input.toggle('alt')
    input.clearOnce()
    expect(input.modifiers).toEqual({ ctrl: 'locked', alt: 'off' })
    input.reset()
    expect(input.modifiers).toEqual({ ctrl: 'off', alt: 'off' })
    expect(seen.at(-1)).toEqual({ ctrl: 'off', alt: 'off' })
  })
  it('sends a paste exactly as pasted, even under a lock', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    input.paste()
    expect(input.data('c')).toBe('c')
    expect(input.modifiers.ctrl).toBe('locked')
  })
  it('ends a composition that committed nothing at once', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    input.compositionStart()
    input.compositionEnd('')
    // xterm delivers nothing; the operator's next keystroke takes the lock.
    input.userEvent()
    expect(input.data('c')).toBe('\x03')
  })
  it('keeps a pending commit raw through a keystroke that arrives before xterm delivers it', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    input.compositionStart()
    input.compositionEnd('c')
    // keydown(229)/Enter before xterm's deferred read: xterm then flushes the commit.
    input.userEvent()
    expect(input.data('c')).toBe('c')
    // The commit arrived: the Enter that flushed it is the operator's keystroke again.
    expect(input.data('\r')).toBe('\r')
    input.userEvent()
    expect(input.data('c')).toBe('\x03')
  })
  it('keeps waiting for the commit through the input events that carry it (iOS)', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    input.compositionStart()
    input.compositionEnd('c')
    input.userEvent()
    input.userEvent()
    expect(input.data('c')).toBe('c')
  })
})
