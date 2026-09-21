'use client'

import { useMemo } from 'react'
import {
  AgentAvatar,
  AgentFilter,
  FacetFilter,
  Page,
  PageBody,
  PageControls,
  PageHeader,
  SearchInput,
} from "@makinbakin/sdk/patterns"
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SystemState, Text } from "@makinbakin/sdk/ui"
import { Inline } from "@makinbakin/sdk/layout"
import { Circle } from 'lucide-react'
import { useAgentList } from "@makinbakin/sdk/hooks"
import { useQueryArrayState, useQueryState } from "@makinbakin/sdk/navigation"
import type { Plan } from '../types'
import { PLAN_SORT_FIELDS, PLAN_STATUS_LABELS, parsePlanSort, sortPlans } from '../lib/plan-sort'
import { PlanTable } from './plan-table'
import { usePlans } from '../hooks/use-plans'

const PLAN_STATUS_OPTIONS = Object.entries(PLAN_STATUS_LABELS).map(([value, label]) => ({ value, label, icon: <Circle className="size-bakin-3" /> }))
const SORT_OPTIONS = Object.entries(PLAN_SORT_FIELDS).flatMap(([field, label]) => [
  { value: `${field}:asc`, label: `${label}: ${field === 'targetDate' ? 'earliest first' : 'A–Z'}` },
  { value: `${field}:desc`, label: `${label}: ${field === 'targetDate' ? 'latest first' : 'Z–A'}` },
])
const SORT_LABELS = Object.fromEntries(SORT_OPTIONS.map(option => [option.value, option.label]))

interface PlanListProps {
  onSelectPlan?: (plan: Plan) => void
  onStartBrainstorm?: () => void
}

export function PlanList({ onSelectPlan, onStartBrainstorm }: PlanListProps) {
  const { plans, loading, error, refresh } = usePlans()
  const agents = useAgentList()
  const [search, setSearch] = useQueryState('q', '')
  const [agentFilter, setAgentFilter] = useQueryState('agent', 'all')
  const [statusFilter, setStatusFilter] = useQueryArrayState('status')
  const [sortQuery, setSortQuery] = useQueryState('sort', 'targetDate:asc')
  const sort = useMemo(() => parsePlanSort(sortQuery), [sortQuery])
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

  const sortedPlans = useMemo(() => sortPlans(filteredPlans, sort, id => agentById.get(id)?.name || id), [filteredPlans, sort, agentById])

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
        <Inline gap="dense">
          <Text size="meta" tone="muted">Sort</Text>
          <Select items={SORT_LABELS} value={`${sort.field}:${sort.dir}`} onValueChange={value => { if (value) setSortQuery(value) }}>
            <SelectTrigger aria-label="Sort plans"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Inline>
      </PageControls>

      <PageBody label="Campaign plans" state={state}>
        <PlanTable
          plans={sortedPlans}
          agentById={agentById}
          sort={sort}
          onSortChange={field => setSortQuery(`${field}:${sort.field === field && sort.dir === 'asc' ? 'desc' : 'asc'}`)}
          onSelectPlan={onSelectPlan}
        />
      </PageBody>
    </Page>
  )
}
