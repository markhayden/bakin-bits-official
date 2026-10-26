import { describe, expect, it } from 'bun:test'
import { fitWidthFont, MAX_FONT, pinchFont, reveal, screenDevice, sizedBy, storedFont, storeFont } from '../components/terminal-view'

function media(coarse: boolean, width = 390, height = 844) {
  return { matchMedia: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }) as MediaQueryList, screen: { width, height } as Screen }
}

function memory(): Storage {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } } as Storage
}

describe('fitting the font', () => {
  it('scales the font so the grid fills the pane width', () => {
    expect(fitWidthFont(13, 1300, 650, 8)).toBe(26)
    expect(fitWidthFont(13, 650, 1300, 8)).toBe(8)
  })

  it('never goes below the device minimum or above the maximum', () => {
    expect(fitWidthFont(13, 100, 1300, 10)).toBe(10)
    expect(fitWidthFont(13, 10_000, 100, 8)).toBe(MAX_FONT)
  })

  it('pinches relative to where the gesture started', () => {
    expect(pinchFont(12, 100, 200, 10)).toBe(24)
    expect(pinchFont(12, 100, 10, 10)).toBe(10)
  })
})

describe('the remembered view', () => {
  it('round-trips a pinched font and clears it on reset', () => {
    const storage = memory()
    storeFont(18, () => storage)
    expect(storedFont(() => storage)).toBe(18)
    storeFont(undefined, () => storage)
    expect(storedFont(() => storage)).toBeUndefined()
  })

  it('ignores garbage and survives storage that throws', () => {
    const storage = memory()
    storage.setItem('bakin-terminal-font', 'huge')
    expect(storedFont(() => storage)).toBeUndefined()
    const blocked = () => { throw new Error('SecurityError') }
    expect(storedFont(blocked)).toBeUndefined()
    expect(() => storeFont(14, blocked)).not.toThrow()
  })
})

describe('reveal', () => {
  const view = { scrollLeft: 100, scrollTop: 100, clientWidth: 300, clientHeight: 200 }
  it('leaves a visible target alone', () => {
    expect(reveal(view, { left: 150, top: 150, width: 8, height: 16 })).toEqual({ left: 100, top: 100 })
  })
  it('scrolls the least distance to a target past either edge', () => {
    expect(reveal(view, { left: 500, top: 400, width: 8, height: 16 }, 4)).toEqual({ left: 212, top: 220 })
    expect(reveal(view, { left: 20, top: 30, width: 8, height: 16 }, 4)).toEqual({ left: 16, top: 26 })
  })
})

describe('naming the size authority', () => {
  it('says this device, the other device kind, or the terminal app, and nothing for an unclaimed session', () => {
    expect(sizedBy({ sizeAuthority: { viewer: 'me', kind: 'browser', device: 'phone' } }, 'me')).toBe('this device')
    expect(sizedBy({ sizeAuthority: { viewer: 'desk', kind: 'browser', device: 'desktop' } }, 'me')).toBe('desktop')
    expect(sizedBy({ sizeAuthority: { viewer: 'tmux', kind: 'native' } }, 'me')).toBe('terminal app')
    expect(sizedBy({}, 'me')).toBeUndefined()
  })

  it('calls a coarse-pointer small screen a phone and everything else a desktop', () => {
    expect(screenDevice(media(true))).toBe('phone')
    expect(screenDevice(media(true, 1024, 1366))).toBe('desktop')
    expect(screenDevice(media(false))).toBe('desktop')
  })
})
