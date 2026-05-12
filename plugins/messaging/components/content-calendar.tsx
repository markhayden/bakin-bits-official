'use client'

import { useMemo, useState } from 'react'
import { AgentFilter } from "@bakin/sdk/components"
import { EmptyState } from "@bakin/sdk/components"
import { FacetFilter } from "@bakin/sdk/components"
import { PluginHeader } from "@bakin/sdk/components"
import { AgentAvatar } from "@bakin/sdk/components"
import { ChannelIcon } from "@bakin/sdk/components"
import { Badge } from "@bakin/sdk/ui"
import { Button } from "@bakin/sdk/ui"
import { Input } from "@bakin/sdk/ui"
import { Skeleton } from "@bakin/sdk/ui"
import { CalendarDays, ChevronLeft, ChevronRight, Circle, Search } from 'lucide-react'
import { useAgentIds } from "@bakin/sdk/hooks"
import { useNotificationChannels } from "@bakin/sdk/hooks"
import { useQueryArrayState, useQueryState } from "@bakin/sdk/hooks"
import type { Deliverable, DeliverableStatus } from '../types'
import { getContentTypeLabel, useContentTypes } from '../hooks/use-content-types'
import { useDeliverables } from '../hooks/use-deliverables'
import { DeliverableDrawer } from './deliverable-drawer'
import { DeliverableStatusBadge } from './deliverable-status-badge'
import { QuickPostButton } from './quick-post-button'

const STATUS_OPTIONS: Array<{ value: DeliverableStatus; label: string; icon: React.ReactNode }> = [
  { value: 'proposed', label: 'Proposed', icon: <Circle className="size-3" /> },
  { value: 'planned', label: 'Planned', icon: <Circle className="size-3" /> },
  { value: 'in_prep', label: 'In prep', icon: <Circle className="size-3" /> },
  { value: 'in_review', label: 'In review', icon: <Circle className="size-3" /> },
  { value: 'changes_requested', label: 'Changes requested', icon: <Circle className="size-3" /> },
  { value: 'approved', label: 'Approved', icon: <Circle className="size-3" /> },
  { value: 'published', label: 'Published', icon: <Circle className="size-3" /> },
  { value: 'overdue', label: 'Overdue', icon: <Circle className="size-3" /> },
  { value: 'cancelled', label: 'Cancelled', icon: <Circle className="size-3" /> },
  { value: 'failed', label: 'Failed', icon: <Circle className="size-3" /> },
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dateKey(value: string): string {
  return value.slice(0, 10)
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function monthKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function monthLabel(value: string): string {
  const date = new Date(`${value}-01T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function matchesSearch(deliverable: Deliverable, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    deliverable.title.toLowerCase().includes(q) ||
    deliverable.brief.toLowerCase().includes(q) ||
    (deliverable.draft.caption ?? '').toLowerCase().includes(q) ||
    (deliverable.draft.agentNotes ?? '').toLowerCase().includes(q)
  )
}

function addMonths(value: string, delta: number): string {
  const date = new Date(`${value}-01T00:00:00`)
  if (Number.isNaN(date.getTime())) return monthKey(new Date())
  date.setMonth(date.getMonth() + delta)
  return monthKey(date)
}

function defaultCalendarMonth(deliverables: Deliverable[]): string {
  const current = monthKey(new Date())
  if (deliverables.some(deliverable => monthKey(new Date(deliverable.publishAt)) === current)) return current
  const first = [...deliverables].sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt))[0]
  return first ? monthKey(new Date(first.publishAt)) : current
}

function appendMissingIds(baseIds: string[], referencedIds: string[]): string[] {
  const seen = new Set(baseIds)
  const result = [...baseIds]
  for (const id of referencedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

export function ContentCalendar() {
  const { deliverables, loading, refresh } = useDeliverables()
  const contentTypes = useContentTypes()
  const agentIds = useAgentIds()
  const channels = useNotificationChannels()
  const [agentFilter, setAgentFilter] = useQueryState('agent', 'all')
  const [statusFilter, setStatusFilter] = useQueryArrayState('status')
  const [typeFilter, setTypeFilter] = useQueryArrayState('type')
  const [channelFilter, setChannelFilter] = useQueryArrayState('channel')
  const [search, setSearch] = useQueryState('q', '')
  const [visibleMonth, setVisibleMonth] = useState<string | null>(null)
  const [selectedDeliverable, setSelectedDeliverable] = useState<Deliverable | null>(null)

  const calendarAgentIds = useMemo(
    () => appendMissingIds(agentIds, deliverables.map((deliverable) => deliverable.agent)),
    [agentIds, deliverables],
  )
  const typeOptions = useMemo(() => {
    const options = new Map(contentTypes.map((type) => [type.id, { value: type.id, label: type.label }]))
    for (const deliverable of deliverables) {
      if (!options.has(deliverable.contentType)) {
        options.set(deliverable.contentType, { value: deliverable.contentType, label: deliverable.contentType })
      }
    }
    return Array.from(options.values())
  }, [contentTypes, deliverables])
  const channelOptions = useMemo(() => {
    const options = new Map(channels.map((channel) => [
      channel.id,
      { value: channel.id, label: channel.label, icon: <ChannelIcon channelId={channel.id} className="size-3.5" /> },
    ]))
    for (const deliverable of deliverables) {
      if (!options.has(deliverable.channel)) {
        options.set(deliverable.channel, {
          value: deliverable.channel,
          label: deliverable.channel,
          icon: <ChannelIcon channelId={deliverable.channel} className="size-3.5" />,
        })
      }
    }
    return Array.from(options.values())
  }, [channels, deliverables])

  const filteredDeliverables = useMemo(() => {
    return deliverables.filter((deliverable) => {
      if (agentFilter !== 'all' && deliverable.agent !== agentFilter) return false
      if (statusFilter.length > 0 && !statusFilter.includes(deliverable.status)) return false
      if (typeFilter.length > 0 && !typeFilter.includes(deliverable.contentType)) return false
      if (channelFilter.length > 0 && !channelFilter.includes(deliverable.channel)) return false
      return matchesSearch(deliverable, search)
    })
  }, [agentFilter, channelFilter, deliverables, search, statusFilter, typeFilter])

  const activeMonth = visibleMonth ?? defaultCalendarMonth(filteredDeliverables)
  const calendarDays = useMemo(() => {
    const groups = new Map<string, Deliverable[]>()
    for (const deliverable of filteredDeliverables) {
      const key = dateKey(deliverable.publishAt)
      const existing = groups.get(key) ?? []
      existing.push(deliverable)
      groups.set(key, existing)
    }
    const first = new Date(`${activeMonth}-01T00:00:00`)
    const start = new Date(first)
    start.setDate(1 - first.getDay())
    return Array.from({ length: 42 }).map((_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      const key = localDateKey(date)
      return {
        key,
        date,
        inMonth: monthKey(date) === activeMonth,
        isToday: key === localDateKey(new Date()),
        deliverables: (groups.get(key) ?? []).sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt)),
      }
    })
  }, [activeMonth, filteredDeliverables])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PluginHeader
        title="Calendar"
        count={filteredDeliverables.length}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search calendar..."
                className="h-8 border-border bg-surface pl-9"
              />
            </div>
            <QuickPostButton onCreated={refresh} />
          </div>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <AgentFilter agentIds={calendarAgentIds} value={agentFilter} onChange={setAgentFilter} />
        <FacetFilter label="Status" options={STATUS_OPTIONS} selected={statusFilter} onChange={setStatusFilter} />
        <FacetFilter label="Type" options={typeOptions} selected={typeFilter} onChange={setTypeFilter} />
        <FacetFilter label="Channel" options={channelOptions} selected={channelFilter} onChange={setChannelFilter} />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border">
            {Array.from({ length: 35 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full rounded-none" />
            ))}
          </div>
        ) : filteredDeliverables.length === 0 ? (
          <EmptyState icon={CalendarDays} title="No deliverables match filters" />
        ) : (
          <div className="min-w-[860px]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  aria-label="Previous month"
                  onClick={() => setVisibleMonth(addMonths(activeMonth, -1))}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  aria-label="Next month"
                  onClick={() => setVisibleMonth(addMonths(activeMonth, 1))}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <h2 className="text-sm font-semibold">{monthLabel(activeMonth)}</h2>
              <Button size="sm" variant="outline" onClick={() => setVisibleMonth(monthKey(new Date()))}>
                Today
              </Button>
            </div>

            <div className="grid grid-cols-7 rounded-t-md border border-b-0 border-border bg-surface text-xs font-medium text-muted-foreground">
              {WEEKDAYS.map(day => (
                <div key={day} className="border-r border-border px-2 py-2 last:border-r-0">{day}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 overflow-hidden rounded-b-md border border-border bg-border">
              {calendarDays.map(day => (
                <div
                  key={day.key}
                  className={`min-h-32 border-r border-b border-border p-2 last:border-r-0 ${
                    day.inMonth ? 'bg-background' : 'bg-surface/60 text-muted-foreground'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className={`flex size-6 items-center justify-center rounded-full text-xs ${
                      day.isToday ? 'bg-primary text-primary-foreground' : ''
                    }`}>
                      {day.date.getDate()}
                    </span>
                    {day.deliverables.length > 0 && (
                      <span className="text-[10px] text-muted-foreground">{day.deliverables.length}</span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {day.deliverables.map((deliverable) => (
                      <button
                        key={deliverable.id}
                        type="button"
                        onClick={() => setSelectedDeliverable(deliverable)}
                        className="w-full rounded border border-border bg-card px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
                        data-testid={`calendar-deliverable-${deliverable.id}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] text-muted-foreground">{formatTime(deliverable.publishAt)}</span>
                          <DeliverableStatusBadge status={deliverable.status} className="h-1.5 w-1.5 shrink-0 rounded-full p-0 text-[0px]" />
                        </div>
                        <div className="mt-0.5 truncate text-xs font-medium">{deliverable.title}</div>
                        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <AgentAvatar agentId={deliverable.agent} size="xs" />
                          <span className="truncate">{deliverable.channel}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge variant="outline" className="max-w-full truncate text-[10px]">
                            {getContentTypeLabel(deliverable.contentType, contentTypes)}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <DeliverableDrawer
        deliverable={selectedDeliverable}
        open={Boolean(selectedDeliverable)}
        onClose={() => setSelectedDeliverable(null)}
        onUpdated={refresh}
      />
    </div>
  )
}
