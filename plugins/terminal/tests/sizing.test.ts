import { describe, expect, it } from 'bun:test'
import { claimSize, FLOOR, nextSize } from '../lib/sizing'
import type { Session } from '../lib/contracts'

const base = { cols: 100, rows: 30, sizeEpoch: 3, sizeRevision: 7, sizeAuthority: { viewer: 'desk-0123456789abcdef', kind: 'browser', device: 'desktop' } } as Session

describe('claimSize', () => {
  it('hands authority to the claiming viewer and opens a new epoch', () => {
    expect(claimSize(base, 'phone-0123456789abcdef', { kind: 'browser', device: 'phone' })).toEqual({ sizeAuthority: { viewer: 'phone-0123456789abcdef', kind: 'browser', device: 'phone' }, sizeEpoch: 4 })
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
