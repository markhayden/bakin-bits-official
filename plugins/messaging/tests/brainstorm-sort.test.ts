import { describe, expect, it } from 'bun:test'
import { parseBrainstormSort, sortBrainstorms } from '../lib/brainstorm-sort'

const rows = [
  { id: 'a', title: 'Session 10', agentId: 'a', status: 'active', updatedAt: '2026-01-15T08:00:00-07:00', proposalCount: 10, approvedCount: 2 },
  { id: 'b', title: 'Session 2', agentId: 'b', status: 'completed', updatedAt: '2026-01-15T13:00:00Z', proposalCount: 2, approvedCount: 10 },
  { id: 'c', title: 'Session 3', agentId: 'c', status: 'active', updatedAt: '', proposalCount: 0, approvedCount: 0 },
]
const agentName = (id: string) => ({ a: 'Zoe', b: 'Ada', c: 'Cora' })[id] || id

describe('Brainstorm table sorting', () => {
  it('defaults to newest updates and rejects malformed query values', () => {
    for (const value of ['', 'constructor:asc', 'title:asc:extra', 'status:invalid']) {
      expect(parseBrainstormSort(value)).toEqual({ field: 'updatedAt', dir: 'desc' })
    }
    expect(parseBrainstormSort('title:asc')).toEqual({ field: 'title', dir: 'asc' })
  })
  it('sorts actual instants and leaves unknown updates last in both directions', () => {
    expect(sortBrainstorms(rows, { field: 'updatedAt', dir: 'desc' }, agentName).map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(sortBrainstorms(rows, { field: 'updatedAt', dir: 'asc' }, agentName).map(row => row.id)).toEqual(['b', 'a', 'c'])
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c'])
  })
  it('sorts counts numerically and titles/agent display names naturally', () => {
    expect(sortBrainstorms(rows, { field: 'proposalCount', dir: 'desc' }, agentName).map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(sortBrainstorms(rows, { field: 'approvedCount', dir: 'desc' }, agentName).map(row => row.id)).toEqual(['b', 'a', 'c'])
    expect(sortBrainstorms(rows, { field: 'title', dir: 'asc' }, agentName).map(row => row.id)).toEqual(['b', 'c', 'a'])
    expect(sortBrainstorms(rows, { field: 'agentId', dir: 'asc' }, agentName).map(row => row.id)).toEqual(['b', 'c', 'a'])
    expect(sortBrainstorms(rows, { field: 'status', dir: 'asc' }, agentName).map(row => row.id)).toEqual(['a', 'c', 'b'])
  })
})
