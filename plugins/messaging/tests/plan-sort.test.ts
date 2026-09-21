import { describe, expect, it } from 'bun:test'
import { parsePlanSort, sortPlans } from '../lib/plan-sort'
import type { Plan } from '../types'

const plan = (id: string, targetDate: string, status: Plan['status'] = 'planning', updatedAt = '2026-05-10T12:00:00Z'): Plan => ({
  id, title: id, targetDate, status, updatedAt, createdAt: updatedAt, agent: 'basil', brief: '', channels: [],
})

describe('Plans table sorting', () => {
  it('defaults invalid URL state to earliest target date', () => {
    for (const value of ['', 'nonsense', 'targetDate:sideways', 'unknown:desc']) {
      expect(parsePlanSort(value)).toEqual({ field: 'targetDate', dir: 'asc' })
    }
    expect(parsePlanSort('title:desc')).toEqual({ field: 'title', dir: 'desc' })
  })

  it('sorts by date then review priority then latest update, without mutating its input', () => {
    const rows = [plan('later', '2026-05-26'), plan('older', '2026-05-25'), plan('recent', '2026-05-25', 'planning', '2026-05-12T12:00:00Z'), plan('review', '2026-05-25', 'needs_review')]
    const ids = rows.map(row => row.id)
    expect(sortPlans(rows, parsePlanSort(''), id => id).map(row => row.id)).toEqual(['review', 'recent', 'older', 'later'])
    expect(sortPlans(rows, parsePlanSort('targetDate:desc'), id => id).map(row => row.id)).toEqual(['later', 'review', 'recent', 'older'])
    expect(rows.map(row => row.id)).toEqual(ids)
  })

  it('keeps missing/invalid dates last in either direction', () => {
    const rows = [plan('missing', ''), plan('valid', '2026-05-25'), plan('invalid', 'bad-date')]
    for (const dir of ['asc', 'desc']) expect(sortPlans(rows, parsePlanSort(`targetDate:${dir}`), id => id)[0].id).toBe('valid')
  })

  it('sorts displayed names, status labels and channels', () => {
    const a = { ...plan('Alpha', '2026-05-25', 'done'), agent: 'z-id', channels: [{ id: 'n', channel: 'newsletter' }] } as Plan
    const b = { ...plan('Beta', '2026-05-25', 'in_prep'), agent: 'a-id', channels: [{ id: 'i', channel: 'instagram' }] } as Plan
    const names = (id: string) => id === 'z-id' ? 'Amy' : 'Zoe'
    expect(sortPlans([b, a], parsePlanSort('agent:asc'), names)[0].id).toBe('Alpha')
    expect(sortPlans([a, b], parsePlanSort('title:desc'), names)[0].id).toBe('Beta')
    expect(sortPlans([a, b], parsePlanSort('channels:asc'), names)[0].id).toBe('Beta')
    expect(sortPlans([a, b], parsePlanSort('status:asc'), names)[0].id).toBe('Beta')
    expect(sortPlans([{ ...a, channels: undefined }, b], parsePlanSort('channels:asc'), names)[0].id).toBe('Beta')
  })
})
