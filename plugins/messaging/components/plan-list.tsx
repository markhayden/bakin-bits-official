'use client'

import { useMemo } from 'react'
import {
  AgentAvatar,
  AgentFilter,
  FacetFilter,
  ListRow,
  ListRowGroup,
  ListRows,
  Page,
  PageBody,
  PageControls,
  PageHeader,
  SearchInput,
  StatusBadge,
} from "@makinbakin/sdk/patterns"
import { Badge, Button, SystemState, Text } from "@makinbakin/sdk/ui"
import { Inline, Stack } from "@makinbakin/sdk/layout"
import { Circle } from 'lucide-react'
import { useAgentList } from "@makinbakin/sdk/hooks"
import { useQueryArrayState, useQueryState } from "@makinbakin/sdk/navigation"
import type { Plan, PlanStatus } from '../types'
import { PLAN_STATUS_TONE } from '../constants'
import { usePlans } from '../hooks/use-plans'

const PLAN_STATUS_OPTIONS: Array<{ value: PlanStatus; label: string; icon: React.ReactNode }> = [
  { value: 'needs_review', label: 'Needs review', icon: <Circle className="size-bakin-3" /> },
  { value: 'planning', label: 'Planning', icon: <Circle className="size-bakin-3" /> },
  { value: 'in_prep', label: 'In production', icon: <Circle className="size-bakin-3" /> },
  { value: 'in_review', label: 'In review', icon: <Circle className="size-bakin-3" /> },
  { value: 'scheduled', label: 'Scheduled', icon: <Circle className="size-bakin-3" /> },
  { value: 'overdue', label: 'Overdue', icon: <Circle className="size-bakin-3" /> },
  { value: 'partially_published', label: 'Partially published', icon: <Circle className="size-bakin-3" /> },
  { value: 'done', label: 'Published', icon: <Circle className="size-bakin-3" /> },
  { value: 'cancelled', label: 'Cancelled', icon: <Circle className="size-bakin-3" /> },
  { value: 'failed', label: 'Failed', icon: <Circle className="size-bakin-3" /> },
]

interface PlanListProps {
  onSelectPlan?: (plan: Plan) => void
  onStartBrainstorm?: () => void
}

/**
 * Plan target dates are date-only (`YYYY-MM-DD`) — a calendar day with no
 * instant. The SDK `formatDateTime` renders instants (and would read a bare
 * date as UTC midnight, shifting the day in western zones), so the day-only
 * formatter stays local.
 */
function formatTargetDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function targetDateKey(value: string): string {
  return value.slice(0, 10)
}

function formatStatus(status: PlanStatus): string {
  return PLAN_STATUS_OPTIONS.find(option => option.value === status)?.label ?? status.replaceAll('_', ' ')
}

export function PlanList({ onSelectPlan, onStartBrainstorm }: PlanListProps) {
  const { plans, loading, error, refresh } = usePlans()
  const agents = useAgentList()
  const [search, setSearch] = useQueryState('q', '')
  const [agentFilter, setAgentFilter] = useQueryState('agent', 'all')
  const [statusFilter, setStatusFilter] = useQueryArrayState('status')
  const agentById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents])
  const planAgentIds = useMemo(
    () => [...new Set([...agents.map(agent => agent.id), ...plans.map(plan => plan.agent)])],
    [agents, plans],
  )
  const agentOptions = useMemo(
    () => planAgentIds.map((agentId) => {
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
    [agentById, planAgentIds],
  )

  const filteredPlans = useMemo(() => {
    return plans.filter((plan) => {
      if (agentFilter !== 'all' && plan.agent !== agentFilter) return false
      if (statusFilter.length > 0 && !statusFilter.includes(plan.status)) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !plan.title.toLowerCase().includes(q) &&
          !plan.brief.toLowerCase().includes(q) &&
          !(plan.campaign ?? '').toLowerCase().includes(q)
        ) return false
      }
      return true
    })
  }, [agentFilter, plans, search, statusFilter])

  const groupedPlans = useMemo(() => {
    const groups = new Map<string, Plan[]>()
    for (const plan of filteredPlans) {
      const key = targetDateKey(plan.targetDate)
      const existing = groups.get(key) ?? []
      existing.push(plan)
      groups.set(key, existing)
    }
    return [...groups.entries()]
      .sort(([a], [b]) => Date.parse(`${a}T00:00:00`) - Date.parse(`${b}T00:00:00`))
      .map(([targetDate, rows]) => ({
        targetDate,
        plans: rows.sort((a, b) => {
          const statusPriority = Number(b.status === 'needs_review') - Number(a.status === 'needs_review')
          if (statusPriority !== 0) return statusPriority
          return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        }),
      }))
  }, [filteredPlans])

  const clearFilters = () => {
    setSearch('')
    setAgentFilter('all')
    setStatusFilter([])
  }

  const state = loading ? (
    <SystemState
      kind="loading"
      scope="page"
      title="Loading plans"
      description="The latest campaign plans will appear here when they are ready."
    />
  ) : error ? (
    <SystemState
      kind="error"
      scope="page"
      title="Could not load plans"
      description={error}
      action={<Button variant="outline" onClick={() => { void refresh() }}>Retry</Button>}
    />
  ) : plans.length === 0 ? (
    <SystemState
      kind="initial-empty"
      scope="page"
      title="No plans yet"
      description="Start a brainstorm to shape the first campaign direction and turn it into a plan."
      action={onStartBrainstorm ? <Button onClick={onStartBrainstorm}>Start brainstorming</Button> : undefined}
    />
  ) : filteredPlans.length === 0 ? (
    <SystemState
      kind="no-results"
      scope="page"
      title="No plans match this view"
      description="Clear the current search and filters to return to every plan."
      action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
    />
  ) : undefined

  return (
    <Page>
      <PageHeader
        title="Plans"
        description="Review campaign direction, channel coverage, and production status before opening a plan to move the work forward."
        meta={loading || error ? undefined : <Badge size="xs" tone="neutral" variant="soft">{filteredPlans.length} shown</Badge>}
        controls={(
          <SearchInput
            align="end"
            label="Search plans"
            value={search}
            onValueChange={setSearch}
            placeholder="Search plans…"
            mobileFullWidth
            className="@3xl/page-header:w-[22rem] @3xl/page-header:shrink-0"
          />
        )}
      />

      <PageControls variant="filters" label="Plan filters">
        <AgentFilter options={agentOptions} value={agentFilter} onValueChange={setAgentFilter} compact />
        <FacetFilter
          label="Status"
          options={PLAN_STATUS_OPTIONS}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
      </PageControls>

      <PageBody label="Campaign plans" state={state}>
        <Stack gap="item">
          {groupedPlans.map(({ targetDate, plans: dayPlans }) => (
            <ListRowGroup
              key={targetDate}
              headerVariant="section"
              headerTone="accent"
              headingLevel={2}
              label={(
                <Inline as="span" justify="between" gap="dense">
                  <span>{formatTargetDate(targetDate)}</span>
                  <span>
                    {dayPlans.length} {dayPlans.length === 1 ? 'plan' : 'plans'}
                  </span>
                </Inline>
              )}
            >
              <ListRows variant="separated" className="border-y-0">
                {dayPlans.map((plan) => {
                  const agent = agentById.get(plan.agent)
                  return (
                    <ListRow
                      key={plan.id}
                      interactive={{ label: `Open plan: ${plan.title}`, onActivate: () => onSelectPlan?.(plan) }}
                    >
                        <Inline align="start" gap="item" wrap={false}>
                          <AgentAvatar
                            agent={{
                              id: plan.agent,
                              name: agent?.name || plan.agent,
                              imageSrc: agent?.headshot || null,
                            }}
                            size="md"
                            decorative
                          />
                          <Stack gap="dense" className="min-w-0 flex-1">
                            <Inline align="start" justify="between" gap="dense">
                              <Text as="h3" weight="semibold" className="min-w-0 break-words">
                                {plan.title}
                              </Text>
                              <StatusBadge size="xs" tone={PLAN_STATUS_TONE[plan.status]}>
                                {formatStatus(plan.status)}
                              </StatusBadge>
                            </Inline>
                            <Text as="p" tone="muted" className="break-words line-clamp-2">
                              {plan.brief}
                            </Text>
                            <Text as="div" size="meta" tone="muted" className="break-words">
                              <Inline gap="item">
                                <span>{agent?.name || plan.agent}</span>
                                {plan.channels && plan.channels.length > 0 && (
                                  <span>{plan.channels.map((channel) => channel.channel).join(', ')}</span>
                                )}
                                {plan.campaign && <span>{plan.campaign}</span>}
                                {plan.sourceSessionId && <span>From brainstorm</span>}
                              </Inline>
                            </Text>
                          </Stack>
                        </Inline>
                    </ListRow>
                  )
                })}
              </ListRows>
            </ListRowGroup>
          ))}
        </Stack>
      </PageBody>
    </Page>
  )
}
