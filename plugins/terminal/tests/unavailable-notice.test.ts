import { describe, expect, it } from 'bun:test'
import { unavailableNotice } from '../lib/unavailable-notice'

describe('unavailableNotice (plan T35b)', () => {
  it('an ended session without its output says why', () => {
    expect(unavailableNotice('not-saved').title).toBe('Output not saved')
    expect(unavailableNotice('evicted')).toMatchObject({ title: 'Output removed', description: expect.stringContaining('storage limit') })
    expect(unavailableNotice('unreadable').title).toBe('Output unavailable')
  })
})
