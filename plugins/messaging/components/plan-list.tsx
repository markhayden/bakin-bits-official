'use client'

import { useMemo } from 'react'
import { AgentFilter } from "@bakin/sdk/components"
import { EmptyState } from "@bakin/sdk/components"
import { FacetFilter } from "@bakin/sdk/components"
import { PluginHeader } from "@bakin/sdk/components"
import { AgentAvatar } from "@bakin/sdk/components"
import { Skeleton } from "@bakin/sdk/ui"
import { ClipboardList, Circle, Search } from 'lucide-react'
import { Input } from "@bakin/sdk/ui"
import { useAgentIds } from "@bakin/sdk/hooks"
import { useQueryArrayState, useQueryState } from "@bakin/sdk/hooks"
import type { Plan, PlanStatus } from '../types'
import { PLAN_STATUS_BADGE } from '../constants'
import { usePlans } from '../hooks/use-plans'

const PLAN_STATUS_OPTIONS: Array<{ value: PlanStatus; label: string; icon: React.ReactNode }> = [
  { value: 'needs_review', label: 'Needs review', icon: <Circle className="size-3" /> },
  { value: 'planning', label: 'Planning', icon: <Circle className="size-3" /> },
  { value: 'in_prep', label: 'In production', icon: <Circle className="size-3" /> },
  { value: 'in_review', label: 'In review', icon: <Circle className="size-3" /> },
  { value: 'scheduled', label: 'Scheduled', icon: <Circle className="size-3" /> },
  { value: 'overdue', label: 'Overdue', icon: <Circle className="size-3" /> },
  { value: 'partially_published', label: 'Partially published', icon: <Circle className="size-3" /> },
  { value: 'done', label: 'Published', icon: <Circle className="size-3" /> },
  { value: 'cancelled', label: 'Cancelled', icon: <Circle className="size-3" /> },
  { value: 'failed', label: 'Failed', icon: <Circle className="size-3" /> },
]

interface PlanListProps {
  onSelectPlan?: (plan: Plan) => void
}

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

export function PlanList({ onSelectPlan }: PlanListProps) {
  const { plans, loading } = usePlans()
  const agentIds = useAgentIds()
  const [search, setSearch] = useQueryState('q', '')
  const [agentFilter, setAgentFilter] = useQueryState('agent', 'all')
  const [statusFilter, setStatusFilter] = useQueryArrayState('status')

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PluginHeader
        title="Plans"
        count={filteredPlans.length}
        actions={
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search plans..."
              className="h-8 border-border bg-surface pl-9"
            />
          </div>
        }
      />

      <div className="mt-4 flex items-center gap-3">
        <AgentFilter agentIds={agentIds} value={agentFilter} onChange={setAgentFilter} />
        <FacetFilter
          label="Status"
          options={PLAN_STATUS_OPTIONS}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        ) : filteredPlans.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No Plans" />
        ) : (
          <div className="grid gap-5">
            {groupedPlans.map(({ targetDate, plans: dayPlans }) => (
              <section key={targetDate} className="grid gap-2">
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <h2 className="text-sm font-semibold">{formatTargetDate(targetDate)}</h2>
                  <span className="text-xs text-muted-foreground">
                    {dayPlans.length} {dayPlans.length === 1 ? 'plan' : 'plans'}
                  </span>
                </div>
                <div className="grid gap-2">
                  {dayPlans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => onSelectPlan?.(plan)}
                      className="rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <h3 className="truncate text-sm font-medium text-foreground">{plan.title}</h3>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] capitalize ${PLAN_STATUS_BADGE[plan.status]}`}>
                              {formatStatus(plan.status)}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{plan.brief}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <AgentAvatar agentId={plan.agent} size="xs" />
                              {plan.agent}
                            </span>
                            {plan.channels && plan.channels.length > 0 && (
                              <span>{plan.channels.map((channel) => channel.channel).join(', ')}</span>
                            )}
                            {plan.campaign && <span>{plan.campaign}</span>}
                            {plan.sourceSessionId && <span>From brainstorm</span>}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
