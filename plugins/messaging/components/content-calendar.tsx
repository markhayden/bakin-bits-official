'use client'

import { useMemo, useState } from 'react'
import { AgentFilter } from "@bakin/sdk/components"
import { EmptyState } from "@bakin/sdk/components"
import { FacetFilter } from "@bakin/sdk/components"
import { PluginHeader } from "@bakin/sdk/components"
import { AgentAvatar } from "@bakin/sdk/components"
import { ChannelIcon } from "@bakin/sdk/components"
import { Badge } from "@bakin/sdk/ui"
import { Input } from "@bakin/sdk/ui"
import { Skeleton } from "@bakin/sdk/ui"
import { CalendarDays, Circle, Search } from 'lucide-react'
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

function dateKey(value: string): string {
  return value.slice(0, 10)
}

function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
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
  const [selectedDeliverable, setSelectedDeliverable] = useState<Deliverable | null>(null)

  const typeOptions = contentTypes.map((type) => ({ value: type.id, label: type.label }))
  const channelOptions = channels.map((channel) => ({
    value: channel.id,
    label: channel.label,
    icon: <ChannelIcon channelId={channel.id} className="size-3.5" />,
  }))

  const filteredDeliverables = useMemo(() => {
    return deliverables.filter((deliverable) => {
      if (agentFilter !== 'all' && deliverable.agent !== agentFilter) return false
      if (statusFilter.length > 0 && !statusFilter.includes(deliverable.status)) return false
      if (typeFilter.length > 0 && !typeFilter.includes(deliverable.contentType)) return false
      if (channelFilter.length > 0 && !channelFilter.includes(deliverable.channel)) return false
      return matchesSearch(deliverable, search)
    })
  }, [agentFilter, channelFilter, deliverables, search, statusFilter, typeFilter])

  const groupedDeliverables = useMemo(() => {
    const groups = new Map<string, Deliverable[]>()
    for (const deliverable of filteredDeliverables) {
      const key = dateKey(deliverable.publishAt)
      const existing = groups.get(key) ?? []
      existing.push(deliverable)
      groups.set(key, existing)
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, rows]) => ({
        day,
        deliverables: rows.sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt)),
      }))
  }, [filteredDeliverables])

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
        <AgentFilter agentIds={agentIds} value={agentFilter} onChange={setAgentFilter} />
        <FacetFilter label="Status" options={STATUS_OPTIONS} selected={statusFilter} onChange={setStatusFilter} />
        <FacetFilter label="Type" options={typeOptions} selected={typeFilter} onChange={setTypeFilter} />
        <FacetFilter label="Channel" options={channelOptions} selected={channelFilter} onChange={setChannelFilter} />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        ) : groupedDeliverables.length === 0 ? (
          <EmptyState icon={CalendarDays} title="No deliverables match filters" />
        ) : (
          <div className="grid gap-5">
            {groupedDeliverables.map(({ day, deliverables: dayDeliverables }) => (
              <section key={day} className="grid gap-2">
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <h2 className="text-sm font-semibold">{formatDay(day)}</h2>
                  <span className="text-xs text-muted-foreground">{dayDeliverables.length}</span>
                </div>
                <div className="grid gap-2">
                  {dayDeliverables.map((deliverable) => (
                    <button
                      key={deliverable.id}
                      type="button"
                      onClick={() => setSelectedDeliverable(deliverable)}
                      className="w-full rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40"
                      data-testid={`calendar-deliverable-${deliverable.id}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {formatTime(deliverable.publishAt)}
                            </span>
                            <h3 className="truncate text-sm font-medium">{deliverable.title}</h3>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{deliverable.brief}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <AgentAvatar agentId={deliverable.agent} size="xs" />
                              {deliverable.agent}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {deliverable.channel}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              {getContentTypeLabel(deliverable.contentType, contentTypes)}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              {deliverable.tone}
                            </Badge>
                          </div>
                        </div>
                        <DeliverableStatusBadge status={deliverable.status} className="shrink-0" />
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
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
