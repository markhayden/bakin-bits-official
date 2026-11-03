import { describe, expect, it } from 'bun:test'
import { claimSize, FLOOR, nextSize, restoreSize } from '../lib/sizing'
import type { Session } from '../lib/contracts'

const desk = { viewer: 'desk-0123456789abcdef', kind: 'browser', device: 'desktop' } as const
const base = { cols: 100, rows: 30, sizeEpoch: 3, sizeRevision: 7, sizeAuthority: desk } as Session

describe('claimSize', () => {
  it('hands authority to the claiming viewer and opens a new epoch', () => {
    expect(claimSize(base, 'phone-0123456789abcdef', { kind: 'browser', device: 'phone' })).toEqual({
      sizeAuthority: { viewer: 'phone-0123456789abcdef', kind: 'browser', device: 'phone' }, sizeEpoch: 4,
      previousSize: { cols: 100, rows: 30, authority: desk },
    })
  })
  it('keeps the previous size when the same screen claims again, and has none before anyone sized', () => {
    const before = { ...base, previousSize: { cols: 44, rows: 30, authority: { viewer: 'phone-0123456789abcdef', kind: 'browser', device: 'phone' } } } as Session
    expect(claimSize(before, 'desk-0123456789abcdef', { kind: 'browser', device: 'desktop' }).previousSize).toEqual(before.previousSize)
    expect(claimSize({ ...base, sizeAuthority: undefined }, 'desk-0123456789abcdef', { kind: 'browser', device: 'desktop' }).previousSize).toBeUndefined()
  })
})

describe('restoreSize', () => {
  it('hands the size back at the previous grid, and the current size becomes the previous (a toggle)', () => {
    const phone = { viewer: 'phone-0123456789abcdef', kind: 'browser', device: 'phone' } as const
    const handedOff = { ...base, ...claimSize(base, phone.viewer, phone), cols: 44, rows: 30 }
    const restored = restoreSize(handedOff, handedOff.sizeEpoch)
    expect(restored).toEqual({ cols: 100, rows: 30, sizeAuthority: desk, sizeEpoch: 5, previousSize: { cols: 44, rows: 30, authority: phone } })
    expect(restoreSize({ ...handedOff, ...restored }, restored.sizeEpoch)).toMatchObject({ cols: 44, rows: 30, sizeAuthority: phone, sizeEpoch: 6 })
  })
  it('refuses when there is nothing to go back to, or the size moved since the screen decided', () => {
    expect(() => restoreSize(base, base.sizeEpoch)).toThrow('There is no previous size to go back to')
    const handedOff = { ...base, ...claimSize(base, 'phone-0123456789abcdef', { kind: 'browser', device: 'phone' }) }
    expect(() => restoreSize(handedOff, base.sizeEpoch)).toThrow('The size changed meanwhile')
  })
})

describe('nextSize', () => {
  it('lets only the current authority at the current epoch resize', () => {
    expect(() => nextSize(base, { viewer: 'phone-0123456789abcdef', epoch: 3, cols: 50, rows: 20 })).toThrow('Another device is sizing this session')
    expect(() => nextSize(base, { viewer: 'desk-0123456789abcdef', epoch: 2, cols: 50, rows: 20 })).toThrow('Another device is sizing this session')
    expect(nextSize(base, { viewer: 'desk-0123456789abcdef', epoch: 3, cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40, sizeRevision: 8 })
  })

  it('clamps to the floor so a phone keyboard can never shrink the grid below it', () => {
    expect(nextSize(base, { viewer: 'desk-0123456789abcdef', epoch: 3, cols: 20, rows: 3 })).toEqual({ cols: FLOOR.cols, rows: FLOOR.rows, sizeRevision: 8 })
  })

  it('does not bump the revision when nothing changes', () => {
    expect(nextSize(base, { viewer: 'desk-0123456789abcdef', epoch: 3, cols: 100, rows: 30 })).toEqual({ cols: 100, rows: 30, sizeRevision: 7 })
  })
})
