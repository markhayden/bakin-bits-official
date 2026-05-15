'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AgentAvatar,
  EmptyState,
  IntegratedBrainstorm,
  PluginHeader,
  readBrainstormSseResponse,
} from "@bakin/sdk/components"
import type { BrainstormMessage } from "@bakin/sdk/components"
import { Badge } from "@bakin/sdk/ui"
import { Button } from "@bakin/sdk/ui"
import { Skeleton } from "@bakin/sdk/ui"
import { ArrowLeft, CalendarDays, CheckCircle2, Circle, ClipboardList, ExternalLink, FileText, Globe2, Info, Instagram, MessageCircle, MessageSquareText, Music2, Rocket, Slack, Trash2, Twitter, type LucideIcon } from 'lucide-react'
import type { BrainstormSession, ContentTypeOption, Deliverable, Plan, PlanChannel, PlanStatus, SessionMessage } from '../types'
import { PLAN_STATUS_BADGE } from '../constants'
import { usePlan } from '../hooks/use-plan'
import { getContentTypeLabel, useContentTypes } from '../hooks/use-content-types'
import { getDistributionChannelDefinition, MESSAGING_DISTRIBUTION_CHANNELS } from '../lib/distribution-channels'
import { DeliverableDrawer } from './deliverable-drawer'
import { DeliverableStatusBadge } from './deliverable-status-badge'

interface PlanWorkspaceProps {
  planId: string
  onBack?: () => void
  onDeleted?: () => void
}

type PlanningTaskState = 'done' | 'current' | 'upcoming' | 'needs_attention'
type PlanWorkspaceTab = 'plan' | 'brainstorm'

interface PlanningTask {
  title: string
  detail: string
  due: string
  state: PlanningTaskState
}

interface DistributionChannelOption {
  id: string
  label: string
  contentType: string
  icon: LucideIcon
}

const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  needs_review: 'Needs review',
  planning: 'Planning',
  in_prep: 'In production',
  in_review: 'In review',
  scheduled: 'Scheduled',
  overdue: 'Needs attention',
  partially_published: 'Partially published',
  done: 'Published',
  cancelled: 'Cancelled',
  failed: 'Needs repair',
}

const TASK_STATE_LABELS: Record<PlanningTaskState, string> = {
  done: 'Done',
  current: 'Now',
  upcoming: 'Next',
  needs_attention: 'Needs attention',
}
const PLAN_WORKSPACE_TABS: Array<{ id: PlanWorkspaceTab; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'brainstorm', label: 'Brainstorm' },
]
const DISTRIBUTION_CHANNEL_ICONS: Record<string, LucideIcon> = {
  blog: FileText,
  x: Twitter,
  instagram: Instagram,
  tiktok: Music2,
  meta: Globe2,
  discord: MessageCircle,
  slack: Slack,
  reddit: MessageSquareText,
  custom: FileText,
}
const DISTRIBUTION_CHANNEL_OPTIONS: DistributionChannelOption[] = MESSAGING_DISTRIBUTION_CHANNELS.map((channel) => ({
  ...channel,
  icon: DISTRIBUTION_CHANNEL_ICONS[channel.id] ?? MessageSquareText,
}))
const DELETE_REQUEST_TIMEOUT_MS = 10000

function toBrainstorm(agentId: string, message: SessionMessage): BrainstormMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    kind: message.role === 'activity' ? message.kind : undefined,
    data: message.role === 'activity' ? message.data : undefined,
    agentId: message.role === 'assistant' ? agentId : message.agentId,
    timestamp: message.timestamp,
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date to set'
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return 'Date to set'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatStatus(status: PlanStatus): string {
  return PLAN_STATUS_LABELS[status] ?? status.replaceAll('_', ' ')
}

function formatRelativeDate(targetDate: string, offsetDays: number): string {
  const date = new Date(`${targetDate}T12:00:00`)
  if (Number.isNaN(date.getTime())) return 'Date to set'
  date.setDate(date.getDate() + offsetDays)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function contentPiecesLabel(count: number): string {
  return `${count} content ${count === 1 ? 'piece' : 'pieces'}`
}

function defaultPublishAt(targetDate: string): string {
  return `${targetDate}T16:00:00Z`
}

function getDistributionChannelOption(channelId: string): DistributionChannelOption {
  const definition = getDistributionChannelDefinition(channelId)
  return {
    ...definition,
    icon: DISTRIBUTION_CHANNEL_ICONS[definition.id] ?? MessageSquareText,
  }
}

function resolveContentTypeId(preferredId: string, contentTypes: ContentTypeOption[]): string {
  if (contentTypes.some((type) => type.id === preferredId)) return preferredId
  return contentTypes[0]?.id ?? 'blog'
}

function DistributionChannelIcon({ channelId, className }: { channelId: string; className?: string }) {
  const Icon = getDistributionChannelOption(channelId).icon
  return <Icon className={className} aria-hidden="true" />
}

function buildPlanningTasks(plan: Plan, deliverables: Deliverable[]): PlanningTask[] {
  const activeDeliverables = deliverables.filter((deliverable) => deliverable.status !== 'cancelled')
  const contentPieces = activeDeliverables.filter((deliverable) => deliverable.status !== 'proposed')
  const plannedCount = contentPieces.filter((deliverable) => deliverable.status === 'planned').length
  const inProductionCount = contentPieces.filter((deliverable) => deliverable.status === 'in_prep').length
  const inReviewCount = contentPieces.filter((deliverable) => deliverable.status === 'in_review').length
  const changesRequestedCount = contentPieces.filter((deliverable) => deliverable.status === 'changes_requested').length
  const approvedCount = contentPieces.filter((deliverable) => deliverable.status === 'approved').length
  const publishedCount = contentPieces.filter((deliverable) => deliverable.status === 'published').length
  const hasContentPieces = contentPieces.length > 0
  const allPublished = hasContentPieces && publishedCount === contentPieces.length
  const channels = new Set((plan.channels ?? []).map((channel) => channel.channel))

  return [
    {
      title: 'Confirm angle and date',
      detail: 'Review the topic, audience angle, and target publishing date.',
      due: formatRelativeDate(plan.targetDate, -21),
      state: plan.brief && plan.targetDate ? 'done' : 'current',
    },
    {
      title: 'Choose channels and formats',
      detail: channels.size > 0
        ? `${channels.size} ${channels.size === 1 ? 'channel is' : 'channels are'} in scope.`
        : 'Pick the channels and content formats for this topic.',
      due: formatRelativeDate(plan.targetDate, -14),
      state: hasContentPieces ? 'done' : 'current',
    },
    {
      title: 'Outline content pieces',
      detail: hasContentPieces
        ? `${contentPieces.length} ${contentPieces.length === 1 ? 'piece is' : 'pieces are'} planned.`
        : 'Create one planned content piece for each channel and format.',
      due: formatRelativeDate(plan.targetDate, -10),
      state: hasContentPieces ? 'done' : 'upcoming',
    },
    {
      title: 'Draft copy and assets',
      detail: inProductionCount > 0
        ? `${inProductionCount} ${inProductionCount === 1 ? 'piece is' : 'pieces are'} in production.`
        : plannedCount > 0
          ? `${plannedCount} planned ${plannedCount === 1 ? 'piece is' : 'pieces are'} ready for production.`
          : 'Prepare captions, article copy, creative prompts, and supporting assets.',
      due: formatRelativeDate(plan.targetDate, -7),
      state: inProductionCount > 0 || plannedCount > 0 ? 'current' : allPublished ? 'done' : 'upcoming',
    },
    {
      title: 'Review and approve',
      detail: changesRequestedCount > 0
        ? `${changesRequestedCount} ${changesRequestedCount === 1 ? 'piece needs' : 'pieces need'} revisions.`
        : inReviewCount > 0
          ? `${inReviewCount} ${inReviewCount === 1 ? 'piece is' : 'pieces are'} waiting on review.`
          : approvedCount > 0
            ? `${approvedCount} ${approvedCount === 1 ? 'piece is' : 'pieces are'} approved.`
            : 'Review drafts for voice, accuracy, and channel fit.',
      due: formatRelativeDate(plan.targetDate, -3),
      state: changesRequestedCount > 0
        ? 'needs_attention'
        : inReviewCount > 0
          ? 'current'
          : approvedCount > 0 || allPublished
            ? 'done'
            : 'upcoming',
    },
    {
      title: 'Schedule and publish',
      detail: allPublished
        ? 'All content pieces have been published.'
        : approvedCount > 0
          ? `${approvedCount} approved ${approvedCount === 1 ? 'piece is' : 'pieces are'} ready to schedule.`
          : 'Schedule approved pieces or publish them when the target date arrives.',
      due: formatDate(plan.targetDate),
      state: allPublished ? 'done' : approvedCount > 0 ? 'current' : 'upcoming',
    },
  ]
}

function PlanningTaskIcon({ state }: { state: PlanningTaskState }) {
  if (state === 'done') return <CheckCircle2 className="mt-0.5 size-3.5 text-emerald-400" aria-hidden="true" />
  if (state === 'needs_attention') return <Circle className="mt-0.5 size-3.5 fill-orange-400 text-orange-400" aria-hidden="true" />
  return <Circle className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden="true" />
}

function DetailRow({
  label,
  icon,
  align = 'center',
  children,
}: {
  label: string
  icon?: ReactNode
  align?: 'center' | 'start'
  children: ReactNode
}) {
  return (
    <div className={`flex gap-2 text-xs text-muted-foreground ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <span className="inline-flex shrink-0 items-center gap-2">
        {icon}
        {label}
      </span>
      <span
        aria-hidden="true"
        className={`min-w-4 flex-1 overflow-hidden whitespace-nowrap font-mono text-[10px] leading-none text-muted-foreground/40 ${
          align === 'start' ? 'mt-1.5' : ''
        }`}
      >
        ................................................................
      </span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  )
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown }
    if (typeof data.error === 'string' && data.error.trim()) return data.error
  } catch {
    // Use the fallback below when the response is not JSON.
  }
  return fallback
}

export function PlanWorkspace({ planId, onBack, onDeleted }: PlanWorkspaceProps) {
  const { plan, deliverables, loading, error, refresh } = usePlan(planId)
  const contentTypes = useContentTypes()
  const [selectedDeliverable, setSelectedDeliverable] = useState<Deliverable | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [channelPendingDelete, setChannelPendingDelete] = useState<PlanChannel | null>(null)
  const [channelDeleteError, setChannelDeleteError] = useState<string | null>(null)
  const [deletingChannel, setDeletingChannel] = useState(false)
  const [savingChannels, setSavingChannels] = useState(false)
  const [startingPrep, setStartingPrep] = useState(false)
  const [kickoffError, setKickoffError] = useState<string | null>(null)
  const [brainstormMessages, setBrainstormMessages] = useState<BrainstormMessage[]>([])
  const [activeTab, setActiveTab] = useState<PlanWorkspaceTab>('plan')
  const activeDeliverables = useMemo(
    () => deliverables.filter((deliverable) => deliverable.status !== 'cancelled'),
    [deliverables],
  )
  const nonProposedDeliverables = useMemo(
    () => activeDeliverables.filter((deliverable) => deliverable.status !== 'proposed'),
    [activeDeliverables],
  )
  const planningTasks = useMemo(
    () => plan ? buildPlanningTasks(plan, deliverables) : [],
    [deliverables, plan],
  )
  const completedTaskCount = planningTasks.filter((task) => task.state === 'done').length
  const progress = planningTasks.length === 0 ? 0 : Math.round((completedTaskCount / planningTasks.length) * 100)
  const planChannels = useMemo(() => plan?.channels ?? [], [plan?.channels])
  const selectedChannels = useMemo(() => planChannels.map((channel) => channel.channel), [planChannels])
  const channelsLocked = activeDeliverables.some((deliverable) => Boolean(deliverable.taskId))
  const channelOptions = useMemo(() => {
    const byId = new Map(DISTRIBUTION_CHANNEL_OPTIONS.map((channel) => [channel.id, channel]))
    for (const channelId of selectedChannels) {
      if (!byId.has(channelId)) byId.set(channelId, getDistributionChannelOption(channelId))
    }
    return [...byId.values()]
  }, [selectedChannels])
  const canKickoffContentPrep = Boolean(plan && activeDeliverables.length === 0)

  useEffect(() => {
    if (!plan?.sourceSessionId) {
      setBrainstormMessages([])
      return
    }
    let cancelled = false
    const loadBrainstorm = async () => {
      const encoded = encodeURIComponent(plan.sourceSessionId!)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}?id=${encoded}`)
      if (!response.ok) return
      const data = await response.json() as { session?: BrainstormSession }
      if (!cancelled && data.session) {
        setBrainstormMessages(data.session.messages.map((message) => toBrainstorm(data.session!.agentId, message)))
      }
    }
    loadBrainstorm()
    return () => {
      cancelled = true
    }
  }, [plan?.sourceSessionId])

  const buildPlanChannel = (option: DistributionChannelOption): PlanChannel => ({
    id: option.id,
    channel: option.id,
    contentType: resolveContentTypeId(option.contentType, contentTypes),
    publishAt: defaultPublishAt(plan?.targetDate ?? new Date().toISOString().slice(0, 10)),
  })

  const updatePlanChannels = async (nextChannels: PlanChannel[]) => {
    if (!plan) return
    setSavingChannels(true)
    setKickoffError(null)
    try {
      const encoded = encodeURIComponent(plan.id)
      const response = await fetch(`/api/plugins/messaging/plans/${encoded}?id=${encoded}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: nextChannels }),
      })
      if (!response.ok) {
        setKickoffError(await readErrorMessage(response, 'Could not update plan channels.'))
        return
      }
      await refresh()
    } finally {
      setSavingChannels(false)
    }
  }

  const togglePlanChannel = async (channelId: string) => {
    const existing = planChannels.find((channel) => channel.channel === channelId)
    const next = existing
      ? planChannels.filter((channel) => channel.channel !== channelId)
      : [...planChannels, buildPlanChannel(getDistributionChannelOption(channelId))]
    await updatePlanChannels(next)
  }

  const startContentPrep = async () => {
    if (!plan) return
    setStartingPrep(true)
    setKickoffError(null)
    try {
      const encoded = encodeURIComponent(plan.id)
      const response = await fetch(`/api/plugins/messaging/plans/${encoded}/activate?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        setKickoffError(await readErrorMessage(response, 'Could not kick off content prep.'))
        return
      }
      await refresh()
    } finally {
      setStartingPrep(false)
    }
  }

  const onBrainstormSend = useCallback(async (
    prompt: string,
    _history: BrainstormMessage[],
    ctx: { signal: AbortSignal; onToken: (text: string) => void; onCustom?: (name: string, data: unknown) => void },
  ): Promise<{ content: string }> => {
    if (!plan?.sourceSessionId) return { content: '' }
    const encoded = encodeURIComponent(plan.sourceSessionId)
    const response = await fetch(`/api/plugins/messaging/sessions/${encoded}/messages?id=${encoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctx.signal,
      body: JSON.stringify({
        message: prompt,
        planId: plan.id,
      }),
    })
    const result = await readBrainstormSseResponse(response, ctx)
    await refresh()
    return result
  }, [plan, refresh])

  const handleDeletePlan = async () => {
    if (!plan) return
    setDeleting(true)
    setDeleteError(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), DELETE_REQUEST_TIMEOUT_MS)
    try {
      const encoded = encodeURIComponent(plan.id)
      const response = await fetch(`/api/plugins/messaging/plans/${encoded}?id=${encoded}&deleteLinkedTasks=true`, {
        method: 'DELETE',
        signal: controller.signal,
      })
      if (!response.ok) {
        setDeleteError(await readErrorMessage(response, 'Could not delete this plan.'))
        return
      }
      setDeleteOpen(false)
      ;(onDeleted ?? onBack)?.()
    } catch (err) {
      setDeleteError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Plan delete timed out. Cleanup may still be running; refresh the Plans list in a moment.'
          : err instanceof Error ? err.message : String(err),
      )
    } finally {
      window.clearTimeout(timeout)
      setDeleting(false)
    }
  }

  const handleDeleteChannel = async () => {
    if (!plan || !channelPendingDelete) return
    setDeletingChannel(true)
    setChannelDeleteError(null)
    try {
      const encodedPlan = encodeURIComponent(plan.id)
      const encodedChannel = encodeURIComponent(channelPendingDelete.id)
      const response = await fetch(`/api/plugins/messaging/plans/${encodedPlan}/channels/${encodedChannel}?id=${encodedPlan}&channelId=${encodedChannel}&deleteLinkedTasks=true`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setChannelDeleteError(await readErrorMessage(response, 'Could not delete this channel.'))
        return
      }
      setChannelPendingDelete(null)
      await refresh()
    } finally {
      setDeletingChannel(false)
    }
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border pb-4">
        {onBack ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            aria-label="Back to plans"
            title="Back to plans"
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AgentAvatar agentId={plan.agent} size="xs" />
            {plan.agent}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-red-400"
            aria-label="Delete plan"
            title="Delete plan"
            onClick={() => {
              setDeleteError(null)
              setDeleteOpen(true)
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="pt-4">
        <PluginHeader
          title={plan.title}
          meta={(
            <Badge className={`${PLAN_STATUS_BADGE[plan.status]}`}>
              {formatStatus(plan.status)}
            </Badge>
          )}
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-6 pt-4 overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-border" role="tablist" aria-label="Plan workspace sections">
            {PLAN_WORKSPACE_TABS.map((tab) => {
              const selected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(tab.id)}
                  className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                    selected
                      ? 'border-foreground text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>

          {activeTab === 'plan' ? (
            <div className="min-h-0 flex-1 overflow-y-auto pr-2 pt-4" role="tabpanel" style={{ scrollbarGutter: 'stable' }}>
              <section className="pb-5">
                {plan.status === 'needs_review' && (
                  <div className="rounded-md border border-sky-500/20 bg-sky-500/10 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-sky-200">
                          <Info className="size-4" aria-hidden="true" />
                          Review this plan before work starts
                        </h2>
                        <p className="mt-1 whitespace-nowrap text-sm leading-6 text-sky-100/80">
                          Confirm the direction, pick channels, and add guidance in the brainstorm before kicking off content prep.
                        </p>
                      </div>
                      {canKickoffContentPrep && selectedChannels.length > 0 && (
                        <Button onClick={startContentPrep} disabled={startingPrep || selectedChannels.length === 0}>
                          <Rocket className="size-4" data-icon="inline-start" />
                          {startingPrep ? 'Starting...' : 'Kickoff content prep'}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                <div className={plan.status === 'needs_review' ? 'mt-5' : ''}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                      <h2 className="text-sm font-semibold">Channels</h2>
                      {!channelsLocked && (
                        <span className="text-xs text-muted-foreground">Select one or more channels</span>
                      )}
                    </div>
                    {savingChannels && <span className="text-xs text-muted-foreground">Saving...</span>}
                  </div>
                  {!channelsLocked && plan.status === 'needs_review' && selectedChannels.length === 0 && (
                    <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
                      <p className="text-xs leading-5 text-amber-100/70">
                        Select one or more channels below. You can also use Brainstorm to ask your agent to suggest channels and update the plan.
                      </p>
                    </div>
                  )}
                  {channelsLocked && (
                    <div className="mt-3 grid gap-2">
                      {planChannels.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                          No channels are linked.
                        </div>
                      ) : (
                        planChannels.map((channel) => (
                          <div key={channel.id} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                              <DistributionChannelIcon channelId={channel.channel} className="size-3.5" />
                              <span className="font-medium text-foreground">{getDistributionChannelOption(channel.channel).label}</span>
                              <span>{getContentTypeLabel(channel.contentType, contentTypes)}</span>
                              <span>{formatDateTime(channel.publishAt)}</span>
                            </div>
                            <button
                              type="button"
                              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                              aria-label={`Delete ${channel.channel} channel`}
                              title={`Delete ${channel.channel} channel`}
                              onClick={() => {
                                setChannelDeleteError(null)
                                setChannelPendingDelete(channel)
                              }}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  {!channelsLocked && (
                    channelOptions.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                        No channels are configured yet.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {channelOptions.map(channel => {
                          const selected = selectedChannels.includes(channel.id)
                          return (
                            <button
                              key={channel.id}
                              type="button"
                              disabled={savingChannels}
                              onClick={() => togglePlanChannel(channel.id)}
                              className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 ${
                                selected ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' : 'border-border bg-surface text-muted-foreground hover:bg-muted/40'
                              }`}
                            >
                              <DistributionChannelIcon channelId={channel.id} className="size-3.5" />
                              {channel.label}
                            </button>
                          )
                        })}
                      </div>
                    )
                  )}
                  {kickoffError && (
                    <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                      {kickoffError}
                    </div>
                  )}
                </div>

                <div className="mt-5">
                  <h2 className="text-sm font-semibold">Brief</h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{plan.brief}</p>
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">Content Pieces</h3>
                  <Badge variant="outline" className="text-[11px]">
                    {contentPiecesLabel(nonProposedDeliverables.length)}
                  </Badge>
                </div>

                {nonProposedDeliverables.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No content pieces have been planned yet.
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
          ) : (
            <div className="min-h-0 flex-1 pt-4" role="tabpanel">
              {plan.sourceSessionId ? (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  {plan.status === 'needs_review' && (
                    <div className="shrink-0 rounded-md bg-surface p-3 text-sm leading-6 text-muted-foreground">
                      Before content prep starts, refine the angle and channels here. A useful first note is which channels this message should use and anything the prep agents should avoid.
                    </div>
                  )}
                  <IntegratedBrainstorm
                    messages={brainstormMessages}
                    onMessagesChange={setBrainstormMessages}
                    onSend={onBrainstormSend}
                    agentId={plan.agent}
                    placeholder="Refine the angle, channels, timeline, or content pieces..."
                    fitParent
                    showHeader={false}
                  />
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                  Brainstorm refinements are available for plans prepared from a brainstorm session.
                </div>
              )}
            </div>
          )}
        </main>

        <aside className="w-[346px] shrink-0 overflow-y-auto border-l border-border pl-6 pr-2" style={{ scrollbarGutter: 'stable' }}>
          <div>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Details</h3>
            <div className="space-y-2 text-xs text-muted-foreground">
              <DetailRow
                label="Target"
                icon={<CalendarDays className="size-3.5" aria-hidden="true" />}
              >
                {formatDate(plan.targetDate)}
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(plan.createdAt)}</DetailRow>
              <DetailRow label="Updated">{formatDateTime(plan.updatedAt)}</DetailRow>
              <DetailRow label="Agent">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <AgentAvatar agentId={plan.agent} size="xs" />
                  <span className="truncate">{plan.agent}</span>
                </span>
              </DetailRow>
              {plan.campaign && (
                <DetailRow label="Campaign">{plan.campaign}</DetailRow>
              )}
              <DetailRow label="Channels" align="start">
                {planChannels.length > 0 ? (
                  <div className="flex min-w-0 flex-wrap justify-end gap-1.5">
                    {planChannels.map((channel) => (
                      <Badge key={channel.id} variant="outline" className="max-w-28 truncate text-[10px]">
                        {getDistributionChannelOption(channel.channel).label}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span>Not set</span>
                )}
              </DetailRow>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Progress</h3>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {canKickoffContentPrep && plan.status !== 'needs_review' && (
            <div className="mt-5 rounded-md border border-border bg-surface p-3">
              <h3 className="text-sm font-semibold">Ready for content prep?</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Kickoff creates one scheduled board task per configured channel.
              </p>
              <Button className="mt-3 w-full justify-center" onClick={startContentPrep} disabled={startingPrep || selectedChannels.length === 0}>
                <Rocket className="size-4" data-icon="inline-start" />
                {startingPrep ? 'Starting...' : 'Kickoff content prep'}
              </Button>
              {selectedChannels.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Choose at least one channel first.</p>}
            </div>
          )}

          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Tasks</h3>
            <div className="space-y-3">
              {planningTasks.map((task) => (
                <div key={task.title} className="flex gap-2.5">
                  <PlanningTaskIcon state={task.state} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium leading-5">{task.title}</p>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {TASK_STATE_LABELS[task.state]}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{task.detail}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">Target: {task.due}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Plan Links</h3>
            <div className="space-y-2 text-[11px] text-muted-foreground">
              {plan.sourceSessionId && (
                <div className="flex items-center gap-2">
                  <MessageSquareText className="size-3.5" aria-hidden="true" />
                  Source brainstorm
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                    {plan.sourceSessionId.slice(0, 8)}
                  </Badge>
                </div>
              )}
              {activeDeliverables.some((deliverable) => deliverable.taskId) && (
                <div className="flex items-center gap-2">
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  Board tasks linked
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    {activeDeliverables.filter((deliverable) => deliverable.taskId).length}
                  </Badge>
                </div>
              )}
              {!plan.sourceSessionId && !activeDeliverables.some((deliverable) => deliverable.taskId) && (
                <p>No linked sessions or board tasks yet.</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      <DeliverableDrawer
        deliverable={selectedDeliverable}
        open={Boolean(selectedDeliverable)}
        onClose={() => setSelectedDeliverable(null)}
        onUpdated={refresh}
      />

      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => {
              if (deleting) return
              setDeleteError(null)
              setDeleteOpen(false)
            }}
          />
          <div className="relative w-[420px] rounded-md border border-border bg-background p-5 shadow-2xl">
            <h2 className="text-sm font-semibold">Delete this plan?</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This removes the plan, its content pieces, and any linked board tasks created for this plan.
            </p>
            {deleteError && (
              <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {deleteError}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={deleting}
                onClick={() => {
                  setDeleteError(null)
                  setDeleteOpen(false)
                }}
              >
                Cancel
              </Button>
              <Button variant="destructive" disabled={deleting} onClick={handleDeletePlan}>
                {deleting ? 'Deleting...' : 'Delete plan'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {channelPendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => {
              if (deletingChannel) return
              setChannelDeleteError(null)
              setChannelPendingDelete(null)
            }}
          />
          <div className="relative w-[420px] rounded-md border border-border bg-background p-5 shadow-2xl">
            <h2 className="text-sm font-semibold">Delete this channel?</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This removes the channel from the plan and deletes its content pieces plus linked board tasks.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              {channelPendingDelete.channel} · {getContentTypeLabel(channelPendingDelete.contentType, contentTypes)}
            </p>
            {channelDeleteError && (
              <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {channelDeleteError}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={deletingChannel}
                onClick={() => {
                  setChannelDeleteError(null)
                  setChannelPendingDelete(null)
                }}
              >
                Cancel
              </Button>
              <Button variant="destructive" disabled={deletingChannel} onClick={handleDeleteChannel}>
                {deletingChannel ? 'Deleting...' : 'Delete channel'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
