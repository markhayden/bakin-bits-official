import { describe, expect, it } from 'bun:test'
import { parseCalendarSort, sortCalendarDeliverables } from '../lib/calendar-sort'
import type { Deliverable } from '../types'

const row = (id: string, publishAt: string, title = id): Deliverable => ({ id, publishAt, title, agent: id, contentType: id, status: 'planned', channel: id } as Deliverable)
const labels = { agentName: (id: string) => ({ a: 'Zoe', b: 'Ada' })[id] || id, typeName: (id: string) => ({ a: 'Video', b: 'Article' })[id] || id }

describe('Calendar list sorting', () => {
  it('defaults safely and rejects malformed or inherited fields', () => {
    for (const value of ['', 'bad:desc', 'constructor:asc', 'title:asc:extra']) expect(parseCalendarSort(value)).toEqual({ field: 'publishAt', dir: 'asc' })
    expect(parseCalendarSort('title:desc')).toEqual({ field: 'title', dir: 'desc' })
  })
  it('sorts actual instants and keeps unknown dates last in both directions without mutating input', () => {
    const rows = [row('a', '2026-01-15T08:00:00-07:00'), row('b', '2026-01-15T13:00:00Z'), row('missing', '')]
    expect(sortCalendarDeliverables(rows, { field: 'publishAt', dir: 'asc' }, labels).map(row => row.id)).toEqual(['b', 'a', 'missing'])
    expect(sortCalendarDeliverables(rows, { field: 'publishAt', dir: 'desc' }, labels).map(row => row.id)).toEqual(['a', 'b', 'missing'])
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'missing'])
  })
  it('sorts displayed agent/type labels and preserves equal-key input order', () => {
    const rows = [row('a', '2026-01-15', 'Same'), row('b', '2026-01-15', 'Same')]
    for (const field of ['agent', 'type'] as const) expect(sortCalendarDeliverables(rows, { field, dir: 'asc' }, labels).map(row => row.id)).toEqual(['b', 'a'])
    expect(sortCalendarDeliverables(rows, { field: 'title', dir: 'desc' }, labels).map(row => row.id)).toEqual(['a', 'b'])
  })
})
