import type { Deliverable } from '../types'

export const CALENDAR_SORT_FIELDS = { publishAt: 'Publishes', title: 'Title', channel: 'Channel', type: 'Type', agent: 'Agent', status: 'Status' } as const
export type CalendarSort = { field: keyof typeof CALENDAR_SORT_FIELDS; dir: 'asc' | 'desc' }

export function parseCalendarSort(value: string): CalendarSort {
  const [field, dir, extra] = value.split(':')
  return Object.hasOwn(CALENDAR_SORT_FIELDS, field) && (dir === 'asc' || dir === 'desc') && extra === undefined
    ? { field: field as CalendarSort['field'], dir }
    : { field: 'publishAt', dir: 'asc' }
}

export function sortCalendarDeliverables(rows: readonly Deliverable[], sort: CalendarSort, labels: {
  agentName: (id: string) => string
  typeName: (id: string) => string
}): Deliverable[] {
  const value = (row: Deliverable): string => {
    switch (sort.field) {
      case 'agent': return labels.agentName(row.agent)
      case 'type': return labels.typeName(row.contentType)
      case 'status': return row.status.replaceAll('_', ' ')
      default: return row[sort.field]
    }
  }
  return [...rows].sort((a, b) => {
    let compared: number
    if (sort.field === 'publishAt') {
      const left = Date.parse(a.publishAt)
      const right = Date.parse(b.publishAt)
      if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1
      compared = Number.isNaN(left) ? 0 : left - right
    } else {
      compared = value(a).localeCompare(value(b), undefined, { numeric: true, sensitivity: 'base' })
    }
    return sort.dir === 'asc' ? compared : -compared
  })
}
