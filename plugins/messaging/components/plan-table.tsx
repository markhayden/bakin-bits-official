'use client'

import { AgentAvatar, DataTable, StatusBadge, type DataTableColumn } from '@makinbakin/sdk/patterns'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { Text } from '@makinbakin/sdk/ui'
import { PLAN_STATUS_TONE } from '../constants'
import { PLAN_STATUS_LABELS, planTargetDate, type PlanSort } from '../lib/plan-sort'
import type { Plan } from '../types'
import { PlanActions } from './plan-actions'

function formatTargetDate(value: string): string {
  // Target dates are local calendar days, not UTC publishing instants.
  const day = planTargetDate(value)
  const date = new Date(`${day}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value || 'Not set' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function PlanTable({ plans, sort, onSortChange, onSelectPlan, onDeletePlan, agentById }: {
  plans: Plan[]
  sort: PlanSort
  onSortChange: (field: string) => void
  onSelectPlan?: (plan: Plan) => void
  onDeletePlan: (plan: Plan, trigger: HTMLButtonElement | null) => void
  agentById: ReadonlyMap<string, { name?: string; headshot?: string | null }>
}) {
  const columns: ReadonlyArray<DataTableColumn<Plan>> = [
    {
      key: 'title', header: 'Plan', sortable: true, narrow: 'primary', headClassName: 'w-2/5',
      cell: plan => (
        <Stack gap="dense">
          <Text weight="semibold">{plan.title}</Text>
          <Text as="p" size="meta" tone="muted" className="line-clamp-2">{plan.brief}</Text>
          {(plan.campaign || plan.sourceSessionId) && <Inline gap="item">
            {plan.campaign && <Text size="meta" tone="muted">{plan.campaign}</Text>}
            {plan.sourceSessionId && <Text size="meta" tone="muted">From brainstorm</Text>}
          </Inline>}
        </Stack>
      ),
      narrowCell: plan => <>
        <Text weight="semibold">{plan.title}</Text>
        <Text as="span" size="meta" tone="muted" className="block line-clamp-2">{plan.brief}</Text>
        {plan.campaign && <Text as="span" size="meta" tone="muted" className="block">{plan.campaign}</Text>}
        {plan.sourceSessionId && <Text as="span" size="meta" tone="muted" className="block">From brainstorm</Text>}
      </>,
    },
    { key: 'targetDate', header: 'Target date', sortable: true, narrow: 'label', cell: plan => formatTargetDate(plan.targetDate) },
    { key: 'status', header: 'Status', sortable: true, narrow: 'label', cell: plan => <StatusBadge size="xs" tone={PLAN_STATUS_TONE[plan.status]}>{PLAN_STATUS_LABELS[plan.status] ?? plan.status}</StatusBadge> },
    {
      key: 'agent', header: 'Agent', sortable: true, narrow: 'label',
      cell: plan => {
        const agent = agentById.get(plan.agent)
        return <Inline gap="dense" wrap={false}>
          <AgentAvatar agent={{ id: plan.agent, name: agent?.name || plan.agent, imageSrc: agent?.headshot || null }} size="sm" decorative />
          <Text size="meta">{agent?.name || plan.agent}</Text>
        </Inline>
      },
      narrowCell: plan => <Text size="meta">{agentById.get(plan.agent)?.name || plan.agent}</Text>,
    },
    { key: 'channels', header: 'Channels', sortable: true, narrow: 'label', cell: plan => plan.channels?.map(channel => channel.channel).join(', ') || 'None' },
    { key: 'actions', header: 'Actions', hideLabel: true, align: 'end', narrow: 'trailing', headClassName: 'w-bakin-10', cell: plan => <PlanActions plan={plan} onDelete={onDeletePlan} /> },
  ]
  return <DataTable
    label="Plans"
    rows={plans}
    columns={columns}
    rowKey={plan => plan.id}
    sort={sort}
    onSortChange={onSortChange}
    onRowActivate={onSelectPlan}
    rowActivateLabel={plan => `Open plan: ${plan.title}`}
    collapseBelow="3xl"
    listVariant="separated"
    tableProps={{ className: 'table-fixed' }}
  />
}
