import { describe, expect, it } from 'bun:test'
import { isKey, ModifierInput, type Scheduler } from '../components/modifier-input'
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

describe('what counts as one key', () => {
  it('single characters, ESC-prefixed characters, and cursor/tilde keys (modified or not)', () => {
    for (const data of ['c', 'é', '你', '\x03', '\x1b', '\x7f', '\x1bc', '\x1b\x7f', '\x1b[A', '\x1bOA', '\x1b[1;5D', '\x1b[3~', '\x1b[5;5~',
      '\x1b[Z', '\x1bOP', '\x1bOR', '\x1b[1;5P', '\x1b[2~', '\x1b[15~', '\x1b[24;5~']) expect(isKey(data)).toBe(true)
  })
  it('not words, and not the replies xterm sends on its own', () => {
    // CSI 1;5 R is both Ctrl+F3 and a cursor-position reply: it stays a reply.
    for (const data of ['echo', '你好', '\x1b[O', '\x1b[I', '\x1b[R', '\x1b[12;3R', '\x1b[1;5R', '\x1b[?1;2c', '\x1b[<0;10;5M', '\x1b[200~c\x1b[201~']) expect(isKey(data)).toBe(false)
  })
})

describe('modifier input', () => {
  it('applies a one-shot modifier to the next key only, however it arrived', () => {
    const { input } = setup()
    input.toggle('ctrl')
    expect(input.data('c')).toBe('\x03')
    expect(input.modifiers.ctrl).toBe('off')
    expect(input.data('c')).toBe('c')
  })
  it('a lock applies to every key: a single IME or Android commit included', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    expect(input.data('c')).toBe('\x03')
    expect(input.data('d')).toBe('\x04')
    expect(input.modifiers.ctrl).toBe('locked')
  })
  it('sends words, dictation and CJK commits as typed; they end a one-shot modifier', () => {
    const { input } = setup()
    input.toggle('ctrl')
    expect(input.data('hello')).toBe('hello')
    expect(input.modifiers.ctrl).toBe('off')
    input.toggle('alt', 'lock')
    expect(input.data('你好')).toBe('你好')
    expect(input.modifiers.alt).toBe('locked')
  })
  it('sends bar keys already encoded, never applying a lock twice', () => {
    const { input } = setup()
    input.toggle('ctrl', 'lock')
    const sent: string[] = []
    input.key('Left', false, bytes => sent.push(input.data(bytes)))
    expect(sent).toEqual(['\x1b[1;5D'])
    expect(input.modifiers.ctrl).toBe('locked')
  })
  it('leaves xterm\'s own replies alone: focus reports, answers and mouse reports neither change nor consume', () => {
    const { input } = setup()
    input.toggle('ctrl')
    for (const reply of ['\x1b[O', '\x1b[12;3R', '\x1b[?1;2c', '\x1b[<0;10;5M']) expect(input.data(reply)).toBe(reply)
    expect(input.modifiers.ctrl).toBe('once')
    const sent: string[] = []
    input.key('Left', false, bytes => sent.push(input.data(bytes)))
    expect(sent).toEqual(['\x1b[1;5D'])
  })
  it('sends a paste exactly as pasted, under a lock too, and only within its event', () => {
    const { input, run } = setup()
    input.toggle('ctrl', 'lock')
    input.toggle('alt')
    input.paste()
    expect(input.modifiers).toEqual({ ctrl: 'locked', alt: 'off' })
    expect(input.data('c')).toBe('c')
    expect(input.data('\x1b[200~c\x1b[201~')).toBe('\x1b[200~c\x1b[201~')
    run(0)
    expect(input.data('c')).toBe('\x03')
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
  it('hardware keys the bar cannot modify still use up a one-shot modifier', () => {
    const { input } = setup()
    for (const key of ['\x1b[Z', '\x1bOP', '\x1bOR', '\x1b[2~', '\x1b[15~']) {
      input.toggle('ctrl')
      expect(input.data(key)).toBe(key)
      expect(input.modifiers.ctrl).toBe('off')
    }
  })
  it('ignores xterm\'s empty composition flush: the key after it takes the modifier', () => {
    const { input } = setup()
    input.toggle('ctrl')
    expect(input.data('')).toBe('')
    expect(input.modifiers.ctrl).toBe('once')
    expect(input.data('\x1b[D')).toBe('\x1b[1;5D')
  })
})

describe('a paste event', () => {
  it('says the next data is pasted, until the event has passed', () => {
    const { input, run } = setup()
    expect(input.isPasting).toBe(false)
    input.paste()
    expect(input.isPasting).toBe(true)
    run(0)
    expect(input.isPasting).toBe(false)
  })
})
