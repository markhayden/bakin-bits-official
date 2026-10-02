import { describe, expect, it } from 'bun:test'
import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { enableWebgl } from '../components/terminal-renderer'

function fixture(failure?: 'construct' | 'activate') {
  let renderer = 'dom'
  let disposed = 0
  let listener: (() => void) | undefined
  const addon = {
    activate() { if (failure === 'activate') throw new Error('GPU unavailable'); renderer = 'webgl' },
    dispose() { disposed++; renderer = 'dom' },
    onContextLoss(callback: () => void) { listener = callback; return { dispose() { listener = undefined } } },
  }
  const terminal = { loadAddon(value: typeof addon) { value.activate() } }
  const cleanup = enableWebgl(terminal as unknown as Terminal, () => {
    if (failure === 'construct') throw new Error('WebGL unavailable')
    return addon as unknown as WebglAddon
  })
  return { cleanup, loseContext: () => listener?.(), state: () => ({ renderer, disposed, listening: Boolean(listener) }) }
}

describe('accelerated terminal renderer', () => {
  it('uses WebGL and releases the addon and listener once on teardown', () => {
    const renderer = fixture()
    expect(renderer.state()).toEqual({ renderer: 'webgl', disposed: 0, listening: true })
    renderer.cleanup()
    renderer.cleanup()
    expect(renderer.state()).toEqual({ renderer: 'dom', disposed: 1, listening: false })
  })
  it('falls back on context loss and remains safe to unmount afterwards', () => {
    const renderer = fixture()
    renderer.loseContext()
    renderer.loseContext()
    renderer.cleanup()
    expect(renderer.state()).toEqual({ renderer: 'dom', disposed: 1, listening: false })
  })
  it('keeps the default renderer if the browser cannot construct the addon', () => {
    const renderer = fixture('construct')
    renderer.cleanup()
    expect(renderer.state()).toEqual({ renderer: 'dom', disposed: 0, listening: false })
  })
  it('cleans up a partially activated addon when GPU initialization fails', () => {
    const renderer = fixture('activate')
    renderer.cleanup()
    expect(renderer.state()).toEqual({ renderer: 'dom', disposed: 1, listening: false })
  })
})


it('falls back once when browser pixel measurements disagree with the display scale', () => {
  let notify: ResizeObserverCallback | undefined
  let disconnected = 0
  let disposed = 0
  const element = {
    ownerDocument: { defaultView: {
      devicePixelRatio: 3,
      ResizeObserver: class {
        constructor(callback: ResizeObserverCallback) { notify = callback }
        observe() {}
        disconnect() { disconnected++ }
      },
    } },
  } as unknown as HTMLElement
  const terminal = { element, loadAddon() {} } as unknown as Terminal
  const cleanup = enableWebgl(terminal, () => ({
    onContextLoss: () => ({ dispose() {} }),
    dispose: () => { disposed++ },
  }) as unknown as WebglAddon)
  const report = (inlineSize: number, blockSize: number) => notify!([{
    target: element,
    contentRect: { width: 390.25, height: 500.25 },
    devicePixelContentBoxSize: [{ inlineSize, blockSize }],
  } as unknown as ResizeObserverEntry], {} as ResizeObserver)
  // Physical pixels can round at fractional boundaries without a mismatch.
  report(1171, 1501)
  expect(disposed).toBe(0)
  // Device emulation incorrectly reports host pixels instead of scaled pixels.
  report(390, 500)
  expect(disposed).toBe(1)
  expect(disconnected).toBe(1)
  cleanup()
  expect(disposed).toBe(1)
  expect(disconnected).toBe(1)
})
