'use client'

import { useMemo, useState } from 'react'
import { AgentAvatar } from "@bakin/sdk/components"
import { EmptyState } from "@bakin/sdk/components"
import { PluginHeader } from "@bakin/sdk/components"
import { Badge } from "@bakin/sdk/ui"
import { Button } from "@bakin/sdk/ui"
import { Skeleton } from "@bakin/sdk/ui"
import { CalendarDays, CheckCircle2, ChevronLeft, ClipboardList, Send } from 'lucide-react'
import type { Deliverable, DeliverableStatus, PlanStatus } from '../types'
import { PLAN_STATUS_BADGE } from '../constants'
import { usePlan } from '../hooks/use-plan'
import { DeliverableDrawer } from './deliverable-drawer'
import { DeliverableStatusBadge } from './deliverable-status-badge'
import { ProposedDeliverablesPanel } from './proposed-deliverables-panel'

interface PlanWorkspaceProps {
  planId: string
  onBack?: () => void
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatStatus(status: PlanStatus | DeliverableStatus): string {
  return status.replaceAll('_', ' ')
}

async function updateDeliverableStatus(deliverable: Deliverable, status: DeliverableStatus): Promise<void> {
  const encoded = encodeURIComponent(deliverable.id)
  await fetch(`/api/plugins/messaging/deliverables/${encoded}?id=${encoded}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

export function PlanWorkspace({ planId, onBack }: PlanWorkspaceProps) {
  const { plan, deliverables, loading, error, refresh } = usePlan(planId)
  const [startingFanOut, setStartingFanOut] = useState(false)
  const [selectedDeliverable, setSelectedDeliverable] = useState<Deliverable | null>(null)
  const activeDeliverables = useMemo(
    () => deliverables.filter((deliverable) => deliverable.status !== 'cancelled'),
    [deliverables],
  )

  const handleStartFanOut = async () => {
    if (!plan) return
    setStartingFanOut(true)
    try {
      const encoded = encodeURIComponent(plan.id)
      await fetch(`/api/plugins/messaging/plans/${encoded}/start-fanout?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      await refresh()
    } finally {
      setStartingFanOut(false)
    }
  }

  const handleApprove = async (deliverable: Deliverable) => {
    await updateDeliverableStatus(deliverable, 'planned')
    await refresh()
  }

  const handleReject = async (deliverable: Deliverable) => {
    await updateDeliverableStatus(deliverable, 'cancelled')
    await refresh()
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error || !plan) {
    return <EmptyState icon={ClipboardList} title="Plan not found" />
  }

  const nonProposedDeliverables = activeDeliverables.filter((deliverable) => deliverable.status !== 'proposed')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3">
        {onBack && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4" data-icon="inline-start" />
            Plans
          </Button>
        )}
      </div>

      <PluginHeader
        title={plan.title}
        count={activeDeliverables.length}
        actions={
          <Button
            size="sm"
            variant={plan.fanOutTaskId ? 'outline' : 'default'}
            disabled={Boolean(plan.fanOutTaskId) || startingFanOut}
            onClick={handleStartFanOut}
          >
            {plan.fanOutTaskId ? (
              <CheckCircle2 className="size-3.5" data-icon="inline-start" />
            ) : (
              <Send className="size-3.5" data-icon="inline-start" />
            )}
            {plan.fanOutTaskId ? 'Fan-out started' : 'Start fan-out'}
          </Button>
        }
      />

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        <div className="grid gap-4">
          <section className="grid gap-3 border-b border-border pb-4 md:grid-cols-[1fr_auto]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={`capitalize ${PLAN_STATUS_BADGE[plan.status]}`}>
                  {formatStatus(plan.status)}
                </Badge>
                {plan.campaign && <Badge variant="outline">{plan.campaign}</Badge>}
                {plan.suggestedChannels?.map((channel) => (
                  <Badge key={channel} variant="outline">{channel}</Badge>
                ))}
              </div>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{plan.brief}</p>
            </div>
            <div className="flex flex-col gap-2 text-xs text-muted-foreground md:min-w-[220px]">
              <span className="inline-flex items-center gap-2">
                <CalendarDays className="size-3.5" />
                {formatDate(plan.targetDate)}
              </span>
              <span className="inline-flex items-center gap-2">
                <AgentAvatar agentId={plan.agent} size="xs" />
                {plan.agent}
              </span>
              {plan.fanOutTaskId && <span className="font-mono">{plan.fanOutTaskId}</span>}
            </div>
          </section>

          <ProposedDeliverablesPanel
            deliverables={deliverables}
            onApprove={handleApprove}
            onReject={handleReject}
          />

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Deliverables</h3>
              <Badge variant="outline" className="text-[11px]">
                {nonProposedDeliverables.length}
              </Badge>
            </div>

            {nonProposedDeliverables.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                No active deliverables
              </div>
            ) : (
              <div className="grid gap-2">
                {nonProposedDeliverables.map((deliverable) => (
                  <button
                    key={deliverable.id}
                    type="button"
                    onClick={() => setSelectedDeliverable(deliverable)}
                    className="w-full rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <h4 className="truncate text-sm font-medium">{deliverable.title}</h4>
                          <Badge variant="outline" className="text-[10px]">{deliverable.channel}</Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{deliverable.brief}</p>
                      </div>
                      <DeliverableStatusBadge status={deliverable.status} className="shrink-0" />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                      <span>{deliverable.contentType}</span>
                      <span>{deliverable.tone}</span>
                      <span>{formatDateTime(deliverable.publishAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
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
