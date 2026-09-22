export const BRAINSTORM_SORT_FIELDS = { title: 'Brainstorm', agentId: 'Agent', status: 'Status', proposalCount: 'Proposals', approvedCount: 'Accepted', updatedAt: 'Updated' } as const
export type BrainstormSort = { field: keyof typeof BRAINSTORM_SORT_FIELDS; dir: 'asc' | 'desc' }

export function parseBrainstormSort(value: string): BrainstormSort {
  const [field, dir, extra] = value.split(':')
  return Object.hasOwn(BRAINSTORM_SORT_FIELDS, field) && (dir === 'asc' || dir === 'desc') && extra === undefined
    ? { field: field as BrainstormSort['field'], dir }
    : { field: 'updatedAt', dir: 'desc' }
}

interface SortableSession {
  title: string; agentId: string; status: string; proposalCount: number; approvedCount: number; updatedAt: string
}

export function sortBrainstorms<Row extends SortableSession>(rows: readonly Row[], sort: BrainstormSort, agentName: (id: string) => string): Row[] {
  return [...rows].sort((a, b) => {
    let compared: number
    if (sort.field === 'updatedAt') {
      const left = Date.parse(a.updatedAt)
      const right = Date.parse(b.updatedAt)
      if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1
      compared = Number.isNaN(left) ? 0 : left - right
    } else if (sort.field === 'proposalCount' || sort.field === 'approvedCount') {
      compared = a[sort.field] - b[sort.field]
    } else {
      const left = sort.field === 'agentId' ? agentName(a.agentId) : a[sort.field]
      const right = sort.field === 'agentId' ? agentName(b.agentId) : b[sort.field]
      compared = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
    }
    return sort.dir === 'asc' ? compared : -compared
  })
}
