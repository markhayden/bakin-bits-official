import { describe, expect, it } from 'bun:test'
import { fitWidthFont, MAX_FONT, minFont, pinchFont, resizePlan, reveal, revealClearOf, screenDevice, sizedBy, storedFont, storeFont, storeMinFont } from '../components/terminal-view'

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

describe('the smallest text', () => {
  it('defaults by device and remembers a chosen floor', () => {
    const storage = memory()
    expect(minFont(media(true), () => storage)).toBe(10)
    expect(minFont(media(false), () => storage)).toBe(8)
    storeMinFont(12, () => storage)
    expect(minFont(media(true), () => storage)).toBe(12)
    storage.setItem('bakin-terminal-min-font', '9')
    expect(minFont(media(true), () => storage)).toBe(10)
    expect(minFont(media(false), () => { throw new Error('SecurityError') })).toBe(8)
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

describe('revealClearOf', () => {
  // A 300x200 window onto 1000x1000 content; the corner controls cover x 220–300, y 0–40 of the window.
  const view = { scrollLeft: 0, scrollTop: 0, clientWidth: 300, clientHeight: 200, scrollWidth: 1000, scrollHeight: 1000 }
  const controls = { left: 220, top: 0, width: 80, height: 40 }
  it('leaves a cursor clear of the controls alone', () => {
    expect(revealClearOf(view, { left: 50, top: 100, width: 8, height: 16 }, { left: 0, top: 80 }, controls)).toEqual({ left: 0, top: 80 })
    expect(revealClearOf(view, { left: 250, top: 100, width: 8, height: 16 }, { left: 0, top: 0 }, undefined)).toEqual({ left: 0, top: 0 })
  })
  it('scrolls a cursor under the controls down below them', () => {
    // On screen at (250, 20): under the controls; scroll up 20 so it sits at y 40.
    expect(revealClearOf(view, { left: 250, top: 120, width: 8, height: 16 }, { left: 0, top: 100 }, controls)).toEqual({ left: 0, top: 80 })
  })
  it('scrolls sideways when the content cannot move down far enough', () => {
    // Content top: no room above, so move the cursor left of the controls instead.
    expect(revealClearOf(view, { left: 250, top: 10, width: 8, height: 16 }, { left: 0, top: 0 }, controls)).toEqual({ left: 38, top: 0 })
  })
  it('gives up when neither direction has room', () => {
    const small = { ...view, scrollWidth: 300, scrollHeight: 200 }
    expect(revealClearOf(small, { left: 250, top: 10, width: 8, height: 16 }, { left: 0, top: 0 }, controls)).toEqual({ left: 0, top: 0 })
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

describe('resizePlan', () => {
  it('sends a height change now at the current width and leaves a width change for later', () => {
    expect(resizePlan({ cols: 100, rows: 20 }, { cols: 100, rows: 30 })).toEqual({ now: { cols: 100, rows: 20 }, later: false })
    expect(resizePlan({ cols: 80, rows: 20 }, { cols: 100, rows: 30 })).toEqual({ now: { cols: 100, rows: 20 }, later: true })
    expect(resizePlan({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toEqual({ later: false })
  })

  it('reconciles a pane that moved back before the server acknowledged', () => {
    // Sent 80×30 for a narrowed pane, which then returned to 100 columns: the acknowledgement asks for 100 again.
    expect(resizePlan({ cols: 100, rows: 30 }, { cols: 80, rows: 30 })).toEqual({ later: true })
  })
})
