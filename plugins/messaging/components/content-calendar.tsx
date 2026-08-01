'use client'

import { useMemo, useState } from 'react'
import {
  AgentAvatar,
  AgentFilter,
  CalendarGrid,
  ChannelIcon,
  FacetFilter,
  ListRow,
  ListRowGroup,
  ListRows,
  Page,
  PageBody,
  PageControls,
  PageHeader,
  SearchInput,
  SegmentedControl,
  StatusMarker,
} from '@makinbakin/sdk/patterns'
import { Badge, Button, SystemState } from '@makinbakin/sdk/ui'
import {
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  List,
} from 'lucide-react'
import { useAgentList, useNotificationChannels } from '@makinbakin/sdk/hooks'
import { useQueryArrayState, useQueryState } from '@makinbakin/sdk/navigation'
import type { Deliverable, DeliverableStatus } from '../types'
import { DELIVERABLE_STATUS_TONE } from '../constants'
import { getContentTypeLabel, useContentTypes } from '../hooks/use-content-types'
import { useDeliverables } from '../hooks/use-deliverables'
import { DeliverableDrawer } from './deliverable-drawer'
import { DeliverableStatusBadge } from './deliverable-status-badge'
import { QuickPostButton } from './quick-post-button'

type CalendarView = 'list' | 'today' | 'week' | 'month'
type CalendarViewOption = {
  value: CalendarView
  icon: typeof List
  label: string
  hideLabel: boolean
}

/** Deliverable flattened into the shared CalendarGrid item shape. */
interface CalendarDeliverableItem {
  key: string
  date: string
  deliverable: Deliverable
}

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

const VIEW_OPTIONS: ReadonlyArray<CalendarViewOption> = [
  { value: 'list', icon: List, label: 'List', hideLabel: true },
  { value: 'today', icon: Clock, label: 'Today', hideLabel: true },
  { value: 'week', icon: CalendarRange, label: 'Week', hideLabel: true },
  { value: 'month', icon: CalendarDays, label: 'Month', hideLabel: true },
]

/**
 * Local-day key for an instant — matches the shared CalendarGrid's LOCAL
 * placement so the plugin's own counts and lists never disagree with the
 * grid. (Slicing the ISO prefix would read the UTC day instead.)
 */
function dateKey(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return localDateKey(date)
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateFromKey(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

function addDays(value: string, delta: number): string {
  const date = dateFromKey(value)
  if (Number.isNaN(date.getTime())) return localDateKey(new Date())
  date.setDate(date.getDate() + delta)
  return localDateKey(date)
}

function startOfWeek(value: string): string {
  const date = dateFromKey(value)
  if (Number.isNaN(date.getTime())) return localDateKey(new Date())
  date.setDate(date.getDate() - date.getDay())
  return localDateKey(date)
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

function dayLabel(value: string): string {
  const date = dateFromKey(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function compactDayLabel(value: string): string {
  const date = dateFromKey(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function weekLabel(value: string): string {
  const start = startOfWeek(value)
  const end = addDays(start, 6)
  const startDate = dateFromKey(start)
  const endDate = dateFromKey(end)
  const sameMonth = startDate.getMonth() === endDate.getMonth()
  const startText = startDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameMonth ? {} : { year: 'numeric' }),
  })
  const endText = endDate.toLocaleDateString('en-US', {
    month: sameMonth ? undefined : 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `${startText} – ${endText}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function statusLabel(status: DeliverableStatus): string {
  return status.replaceAll('_', ' ')
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
  const date = dateFromKey(value)
  if (Number.isNaN(date.getTime())) return localDateKey(new Date())
  date.setMonth(date.getMonth() + delta)
  return localDateKey(date)
}

function defaultCalendarDate(deliverables: Deliverable[]): string {
  const today = localDateKey(new Date())
  if (deliverables.some(deliverable => dateKey(deliverable.publishAt) === today)) return today
  const first = [...deliverables].sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt))[0]
  return first ? dateKey(first.publishAt) : today
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

function isCalendarVisibleDeliverable(deliverable: Deliverable): boolean {
  if (deliverable.status === 'cancelled' || deliverable.status === 'proposed') return false
  if (deliverable.planId && !deliverable.taskId) return false
  return true
}

interface CalendarDeliverableProps {
  deliverable: Deliverable
  agentById: Map<string, { id: string; name: string; headshot?: string | null }>
  contentTypes: ReturnType<typeof useContentTypes>
  onSelect: (deliverable: Deliverable) => void
  mode?: 'card' | 'row'
}

function CalendarDeliverable({
  deliverable,
  agentById,
  contentTypes,
  onSelect,
  mode = 'card',
}: CalendarDeliverableProps) {
  const agent = agentById.get(deliverable.agent)
  const identity = {
    id: deliverable.agent,
    name: agent?.name || deliverable.agent,
    imageSrc: agent?.headshot || null,
  }

  if (mode === 'row') {
    return (
      <Button
        variant="ghost"
        onClick={() => onSelect(deliverable)}
        className="flex !h-auto w-full min-w-0 items-center justify-start gap-bakin-3 whitespace-normal rounded-none px-bakin-3 py-bakin-3 text-left font-bakin-typography-weight-regular hover:bg-bakin-surface-elevated"
        data-testid={`calendar-deliverable-${deliverable.id}`}
      >
        <AgentAvatar agent={identity} size="sm" decorative />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-bakin-2">
            <span className="truncate font-bakin-typography-weight-semibold">{deliverable.title}</span>
            <DeliverableStatusBadge status={deliverable.status} />
          </span>
          <span className="mt-bakin-1 block truncate text-bakin-typography-size-meta text-bakin-text-muted">
            {formatTime(deliverable.publishAt)} · {deliverable.channel} · {getContentTypeLabel(deliverable.contentType, contentTypes)}
          </span>
        </span>
        <ChevronRight className="size-bakin-4 shrink-0 text-bakin-text-muted" aria-hidden="true" />
      </Button>
    )
  }

  return (
    <Button
      variant="outline"
      onClick={() => onSelect(deliverable)}
      className="block !h-auto w-full whitespace-normal rounded-bakin-control bg-bakin-surface-default px-bakin-2 py-bakin-2 text-left font-bakin-typography-weight-regular hover:bg-bakin-surface-elevated"
      data-testid={`calendar-deliverable-${deliverable.id}`}
    >
      <div className="flex min-w-0 items-center gap-bakin-2">
        <span className="shrink-0 font-bakin-typography-family-mono text-bakin-typography-size-meta text-bakin-text-muted">
          {formatTime(deliverable.publishAt)}
        </span>
        <StatusMarker
          tone={DELIVERABLE_STATUS_TONE[deliverable.status]}
          label={statusLabel(deliverable.status)}
        />
      </div>
      <div className="mt-bakin-1 truncate text-bakin-typography-size-meta font-bakin-typography-weight-semibold">
        {deliverable.title}
      </div>
      <div className="mt-bakin-1 flex min-w-0 items-center gap-bakin-1 text-bakin-typography-size-meta text-bakin-text-muted">
        <AgentAvatar agent={identity} size="xs" decorative />
        <span className="truncate">{deliverable.channel}</span>
      </div>
      <div className="mt-bakin-1 flex flex-wrap gap-bakin-1">
        <Badge variant="outline" size="xs" className="max-w-full truncate">
          {getContentTypeLabel(deliverable.contentType, contentTypes)}
        </Badge>
      </div>
    </Button>
  )
}

export function ContentCalendar() {
  const { deliverables, loading, refresh } = useDeliverables()
  const contentTypes = useContentTypes()
  const agents = useAgentList()
  const channels = useNotificationChannels()
  const [agentFilter, setAgentFilter] = useQueryState('agent', 'all')
  const [statusFilter, setStatusFilter] = useQueryArrayState('status')
  const [typeFilter, setTypeFilter] = useQueryArrayState('type')
  const [channelFilter, setChannelFilter] = useQueryArrayState('channel')
  const [search, setSearch] = useQueryState('q', '')
  const [view, setView] = useQueryState('view', 'month')
  const calendarView: CalendarView = VIEW_OPTIONS.some(option => option.value === view)
    ? view as CalendarView
    : 'month'
  const [visibleDate, setVisibleDate] = useState<string | null>(null)
  const [selectedDeliverable, setSelectedDeliverable] = useState<Deliverable | null>(null)
  const calendarDeliverables = useMemo(
    () => deliverables.filter(isCalendarVisibleDeliverable),
    [deliverables],
  )

  const calendarAgentIds = useMemo(
    () => appendMissingIds(agents.map(agent => agent.id), calendarDeliverables.map(deliverable => deliverable.agent)),
    [agents, calendarDeliverables],
  )
  const agentById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents])
  const agentOptions = useMemo(
    () => calendarAgentIds.map((agentId) => {
      const agent = agentById.get(agentId)
      const identity = {
        id: agentId,
        name: agent?.name || agentId,
        imageSrc: agent?.headshot || null,
      }
      return {
        value: agentId,
        label: identity.name,
        visual: <AgentAvatar agent={identity} size="sm" decorative />,
      }
    }),
    [agentById, calendarAgentIds],
  )
  const typeOptions = useMemo(() => {
    const options = new Map(contentTypes.map(type => [type.id, { value: type.id, label: type.label }]))
    for (const deliverable of calendarDeliverables) {
      if (!options.has(deliverable.contentType)) {
        options.set(deliverable.contentType, { value: deliverable.contentType, label: deliverable.contentType })
      }
    }
    return Array.from(options.values())
  }, [calendarDeliverables, contentTypes])
  const channelOptions = useMemo(() => {
    const options = new Map(channels.map(channel => [
      channel.id,
      { value: channel.id, label: channel.label, icon: <ChannelIcon channelId={channel.id} className="size-3.5" /> },
    ]))
    for (const deliverable of calendarDeliverables) {
      if (!options.has(deliverable.channel)) {
        options.set(deliverable.channel, {
          value: deliverable.channel,
          label: deliverable.channel,
          icon: <ChannelIcon channelId={deliverable.channel} className="size-3.5" />,
        })
      }
    }
    return Array.from(options.values())
  }, [calendarDeliverables, channels])

  const filteredDeliverables = useMemo(() => calendarDeliverables.filter((deliverable) => {
    if (agentFilter !== 'all' && deliverable.agent !== agentFilter) return false
    if (statusFilter.length > 0 && !statusFilter.includes(deliverable.status)) return false
    if (typeFilter.length > 0 && !typeFilter.includes(deliverable.contentType)) return false
    if (channelFilter.length > 0 && !channelFilter.includes(deliverable.channel)) return false
    return matchesSearch(deliverable, search)
  }), [agentFilter, calendarDeliverables, channelFilter, search, statusFilter, typeFilter])

  const activeDate = visibleDate ?? defaultCalendarDate(filteredDeliverables)
  const activeMonth = monthKey(dateFromKey(activeDate))
  const hasActiveFilters = (
    agentFilter !== 'all' ||
    statusFilter.length > 0 ||
    typeFilter.length > 0 ||
    channelFilter.length > 0 ||
    search.length > 0
  )
  const clearFilters = () => {
    setAgentFilter('all')
    setStatusFilter([])
    setTypeFilter([])
    setChannelFilter([])
    setSearch('')
  }

  // Chronological item order — the shared CalendarGrid preserves input order
  // inside every cell, so each day stacks by publish time.
  const calendarItems = useMemo<CalendarDeliverableItem[]>(
    () => [...filteredDeliverables]
      .sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt))
      .map((deliverable) => ({
        key: deliverable.id,
        // Full ISO instants pass straight through; the kit parses plain
        // YYYY-MM-DD strings as LOCAL midnight itself.
        date: deliverable.publishAt,
        deliverable,
      })),
    [filteredDeliverables],
  )

  const groupedDeliverables = useMemo(() => {
    const groups = new Map<string, Deliverable[]>()
    for (const item of calendarItems) {
      const key = dateKey(item.deliverable.publishAt)
      const existing = groups.get(key) ?? []
      existing.push(item.deliverable)
      groups.set(key, existing)
    }
    return groups
  }, [calendarItems])

  const listGroups = useMemo(
    () => Array.from(groupedDeliverables.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [groupedDeliverables],
  )

  const state = loading ? (
    <SystemState
      kind="loading"
      scope="page"
      title="Loading the content calendar"
      description="Scheduled deliverables will appear as soon as the current messaging plan is available."
    />
  ) : filteredDeliverables.length === 0 && hasActiveFilters ? (
    <SystemState
      kind="no-results"
      scope="page"
      title="No deliverables match this view"
      description="The current search and filters exclude every scheduled deliverable."
      action={<Button variant="outline" onClick={clearFilters}>Clear search and filters</Button>}
    />
  ) : filteredDeliverables.length === 0 ? (
    <SystemState
      kind="initial-empty"
      scope="page"
      title="No scheduled deliverables yet"
      description="Create a quick post to add the first item to the messaging calendar."
      action={<QuickPostButton onCreated={refresh} />}
    />
  ) : undefined

  const navigate = (direction: -1 | 1) => {
    if (calendarView === 'today') setVisibleDate(addDays(activeDate, direction))
    if (calendarView === 'week') setVisibleDate(addDays(activeDate, direction * 7))
    if (calendarView === 'month') setVisibleDate(addMonths(activeDate, direction))
  }
  const activeRangeLabel = calendarView === 'today'
    ? dayLabel(activeDate)
    : calendarView === 'week'
      ? weekLabel(activeDate)
      : monthLabel(activeMonth)

  const navigation = calendarView !== 'list' ? (
    <div className="flex min-w-0 items-center justify-between gap-bakin-3" data-slot="calendar-navigation">
      <div className="flex items-center gap-bakin-1">
        <Button size="icon-sm" variant="ghost" aria-label={`Previous ${calendarView}`} onClick={() => navigate(-1)}>
          <ChevronLeft className="size-bakin-4" aria-hidden="true" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Next ${calendarView}`} onClick={() => navigate(1)}>
          <ChevronRight className="size-bakin-4" aria-hidden="true" />
        </Button>
      </div>
      <h2 className="min-w-0 truncate text-bakin-typography-size-section-title font-bakin-typography-weight-semibold">
        {activeRangeLabel}
      </h2>
      <Button size="sm" variant="outline" onClick={() => setVisibleDate(localDateKey(new Date()))}>
        Today
      </Button>
    </div>
  ) : null

  const renderDeliverable = (deliverable: Deliverable, mode?: 'card' | 'row') => (
    <CalendarDeliverable
      key={deliverable.id}
      deliverable={deliverable}
      agentById={agentById}
      contentTypes={contentTypes}
      onSelect={setSelectedDeliverable}
      mode={mode}
    />
  )

  const renderDayCount = (day: Date) => {
    const count = (groupedDeliverables.get(localDateKey(day)) ?? []).length
    if (count === 0) return null
    return (
      <span className="text-bakin-typography-size-meta text-bakin-text-muted">
        {count === 1 ? '1 post' : `${count} posts`}
      </span>
    )
  }

  const todayDeliverables = groupedDeliverables.get(activeDate) ?? []

  return (
    <Page>
      <PageHeader
        title="Calendar"
        description="Plan and review content across channels, then see exactly when each deliverable is scheduled to publish."
        meta={<Badge size="xs" tone="neutral" variant="outline">{filteredDeliverables.length} shown</Badge>}
        controlsLabel="Calendar search, view, and actions"
        controls={(
          <div className="grid w-full min-w-0 gap-bakin-2 @3xl/page-header:flex @3xl/page-header:items-start">
            <SearchInput
              align="end"
              label="Search calendar"
              value={search}
              onValueChange={setSearch}
              placeholder="Search calendar…"
              mobileFullWidth
            className="@3xl/page-header:w-[22rem] @3xl/page-header:shrink-0"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-bakin-2 @3xl/page-header:shrink-0 @3xl/page-header:flex-nowrap">
              <SegmentedControl
                ariaLabel="Calendar view"
                options={VIEW_OPTIONS}
                value={calendarView}
                onValueChange={(value: CalendarView) => {
                  setView(value)
                  setVisibleDate(null)
                }}
                className="shrink-0 [&_[role=tab]]:px-bakin-3"
              />
              <QuickPostButton onCreated={refresh} />
            </div>
          </div>
        )}
      />

      <PageControls label="Calendar filters">
        <AgentFilter options={agentOptions} value={agentFilter} onValueChange={setAgentFilter} compact />
        <FacetFilter label="Status" options={STATUS_OPTIONS} selected={statusFilter} onChange={setStatusFilter} />
        <FacetFilter label="Type" options={typeOptions} selected={typeFilter} onChange={setTypeFilter} />
        <FacetFilter label="Channel" options={channelOptions} selected={channelFilter} onChange={setChannelFilter} />
      </PageControls>

      <PageBody label="Scheduled deliverables" state={state}>
        {navigation}

        {calendarView === 'month' && (
          <div data-testid="calendar-view-month">
            <CalendarGrid
              view="month"
              date={dateFromKey(activeDate)}
              label={`${monthLabel(activeMonth)} content calendar`}
              items={calendarItems}
              outsideDays="muted"
              dimPastDays
              renderDayHeader={renderDayCount}
              renderItem={(item) => renderDeliverable(item.deliverable)}
            />
          </div>
        )}

        {calendarView === 'week' && (
          <div data-testid="calendar-view-week">
            <CalendarGrid
              view="week"
              granularity="day"
              date={dateFromKey(activeDate)}
              label={`${weekLabel(activeDate)} content calendar`}
              items={calendarItems}
              renderItem={(item) => renderDeliverable(item.deliverable)}
            />
          </div>
        )}

        {calendarView === 'today' && (
          <div data-testid="calendar-view-today">
            {todayDeliverables.length > 0 ? (
              <CalendarGrid
                view="day"
                granularity="day"
                date={dateFromKey(activeDate)}
                label={`${dayLabel(activeDate)} content calendar`}
                items={calendarItems}
                renderItem={(item) => (
                  <div className="overflow-hidden rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default">
                    {renderDeliverable(item.deliverable, 'row')}
                  </div>
                )}
              />
            ) : (
              <SystemState
                kind="initial-empty"
                scope="section"
                title="Nothing scheduled this day"
                description="Choose another day or create a quick post."
              />
            )}
          </div>
        )}

        {calendarView === 'list' && (
          <div className="space-y-5" data-testid="calendar-view-list">
            {listGroups.map(([key, items]) => (
              <ListRowGroup key={key} label={compactDayLabel(key)}>
                <ListRows variant="bordered">
                  {items.map(deliverable => (
                    <ListRow key={deliverable.id} className="overflow-hidden p-0">
                      {renderDeliverable(deliverable, 'row')}
                    </ListRow>
                  ))}
                </ListRows>
              </ListRowGroup>
            ))}
          </div>
        )}
      </PageBody>

      <DeliverableDrawer
        deliverable={selectedDeliverable}
        open={Boolean(selectedDeliverable)}
        onClose={() => setSelectedDeliverable(null)}
        onUpdated={refresh}
      />
    </Page>
  )
}
