'use client'

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ConversationPanel } from "@makinbakin/sdk/conversation"
import type { ConversationAgent, ConversationMessage } from "@makinbakin/sdk/conversation"
import {
  AgentAvatar,
  ConfirmDialog,
  ListRow,
  ListRows,
  Page,
  PageBody,
  PageHeader,
  StatusBadge,
  StatusMarker,
} from "@makinbakin/sdk/patterns"
import { useAgentList, useHorizontalResize } from "@makinbakin/sdk/hooks"
import { Alert, AlertDescription, AlertTitle, Badge } from "@makinbakin/sdk/ui"
import { Tabs, TabsList, TabsTrigger } from "@makinbakin/sdk/ui"
import { Button } from "@makinbakin/sdk/ui"
import { DropdownMenuItem } from "@makinbakin/sdk/ui"
import { Progress } from "@makinbakin/sdk/ui"
import { Skeleton } from "@makinbakin/sdk/ui"
import { SystemState } from "@makinbakin/sdk/ui"
import { ArrowLeft, CalendarDays, ExternalLink, FileText, Globe2, Info, Instagram, MessageCircle, MessageSquareText, Music2, Rocket, Slack, Trash2, Twitter, type LucideIcon } from 'lucide-react'
import type { BrainstormSession, ContentTypeOption, Deliverable, Plan, PlanChannel, PlanStatus, SessionMessage } from '../types'
import { PLAN_STATUS_TONE } from '../constants'
import { usePlan } from '../hooks/use-plan'
import { useConversationStream } from '../hooks/use-conversation-stream'
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

function toConversation(agentId: string, message: SessionMessage): ConversationMessage | null {
  if (message.role === 'user') {
    return { kind: 'user', ts: message.timestamp, content: message.content }
  }
  if (message.role === 'assistant') {
    return { kind: 'assistant', ts: message.timestamp, agentId, content: message.content }
  }
  if (message.kind === 'tool_call') {
    const data = (message.data ?? {}) as { callId?: string; toolName?: string; status?: string; summary?: string }
    return {
      kind: 'tool',
      ts: message.timestamp,
      agentId,
      toolName: data.toolName ?? 'tool',
      status: data.status === 'failed' ? 'failed' : 'completed',
      summary: data.summary ?? message.content,
    }
  }
  if (message.kind === 'error') {
    return { kind: 'error', ts: message.timestamp, message: message.content }
  }
  return null
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
  const tone = state === 'done'
    ? 'success'
    : state === 'needs_attention'
      ? 'attention'
      : 'neutral'
  return (
    <span className="mt-bakin-1 shrink-0">
      <StatusMarker tone={tone} />
    </span>
  )
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
    <div className={`flex gap-bakin-2 text-bakin-typography-size-meta text-bakin-text-muted ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <span className="inline-flex shrink-0 items-center gap-bakin-2">
        {icon}
        {label}
      </span>
      <span
        aria-hidden="true"
        className={`min-w-bakin-4 flex-1 overflow-hidden whitespace-nowrap font-bakin-typography-family-mono text-bakin-typography-size-meta leading-none text-bakin-text-muted/40 ${
          align === 'start' ? 'mt-bakin-1' : ''
        }`}
      >
        ................................................................
      </span>
      <span className="min-w-0 text-right text-bakin-text-primary">{children}</span>
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

function PlanBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="rounded-bakin-pill"
      aria-label="Back to plans"
      title="Back to plans"
      onClick={onBack}
    >
      <ArrowLeft aria-hidden="true" />
    </Button>
  )
}

function PlanStateHeader({ planId, onBack }: { planId: string; onBack?: () => void }) {
  return (
    <PageHeader
      measure="wide"
      navigation={onBack ? <PlanBackButton onBack={onBack} /> : undefined}
      eyebrow="Messaging / Plan"
      title="Plan detail"
      meta={<code className="font-bakin-typography-family-mono">{planId}</code>}
    />
  )
}

export function PlanWorkspace({ planId, onBack, onDeleted }: PlanWorkspaceProps) {
  const { plan, deliverables, loading, error, refresh } = usePlan(planId)
  const contentTypes = useContentTypes()
  // The focused conversation kit never reads host stores — the consumer
  // resolves agent identity and hands presentation-ready values down.
  const agents = useAgentList()
  const planAgent = useMemo(
    () => agents.find((agent) => agent.id === plan?.agent),
    [agents, plan?.agent],
  )
  const planAgentIdentity = useMemo(
    () => plan
      ? { id: plan.agent, name: planAgent?.name || plan.agent, imageSrc: planAgent?.headshot || null }
      : null,
    [plan, planAgent],
  )
  const conversationAgent = useMemo<ConversationAgent | undefined>(
    () => plan
      ? {
        id: plan.agent,
        name: planAgent?.name || plan.agent,
        ...(planAgent?.headshot ? { avatarUrl: planAgent.headshot } : {}),
      }
      : undefined,
    [plan, planAgent],
  )
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
  const [brainstormMessages, setBrainstormMessages] = useState<ConversationMessage[]>([])
  const [activeTab, setActiveTab] = useState<PlanWorkspaceTab>('plan')

  // Draggable divider between the main plan column and the details/tasks sidebar.
  const { width: sidebarWidth, handleProps: sidebarResizeProps } = useHorizontalResize({
    defaultWidth: 346,
    minWidth: 280,
    maxWidth: 640,
    storageKey: 'messaging-plan-sidebar',
  })
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
        setBrainstormMessages(data.session.messages.map((message) => toConversation(data.session!.agentId, message)).filter((m): m is ConversationMessage => m !== null))
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

  // Plan refinements ride the same sessions route with planId; plan_update
  // custom events land via the post-turn refresh.
  const brainstorm = useConversationStream({
    fetcher: useCallback((content: string, ctx: { signal: AbortSignal }) => {
      if (!plan?.sourceSessionId) throw new Error('Plan has no source session')
      const encoded = encodeURIComponent(plan.sourceSessionId)
      return fetch(`/api/plugins/messaging/sessions/${encoded}/messages?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({
          message: content,
          planId: plan.id,
        }),
      })
    }, [plan]),
    onDone: useCallback(async () => {
      await refresh()
    }, [refresh]),
    onError: useCallback(async () => {
      await refresh()
    }, [refresh]),
  })

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
      <Page>
        <PlanStateHeader planId={planId} onBack={onBack} />
        <PageBody
          state={(
            <SystemState
              kind="loading"
              scope="page"
              title="Loading plan"
              description="The plan direction, content pieces, and production progress will appear here."
              preview={(
                <div className="grid gap-bakin-3">
                  <Skeleton className="h-bakin-8 w-full max-w-lg" />
                  <Skeleton className="h-32 w-full rounded-bakin-surface" />
                </div>
              )}
            />
          )}
        />
      </Page>
    )
  }

  if (error || !plan) {
    return (
      <Page>
        <PlanStateHeader planId={planId} onBack={onBack} />
        <PageBody
          state={(
            <SystemState
              kind="error"
              scope="page"
              recovery="available"
              title="Plan details couldn't load"
              description={error || "This plan may have been deleted or the link may be stale."}
              action={onBack ? <Button variant="outline" onClick={onBack}>Open plans</Button> : <Button variant="outline" onClick={() => void refresh()}>Try again</Button>}
            />
          )}
        />
      </Page>
    )
  }

  return (
    <Page
      scroll="contained"
      data-plan-workspace=""
    >
      <PageHeader
        measure="wide"
        navigation={onBack ? <PlanBackButton onBack={onBack} /> : undefined}
        eyebrow="Messaging / Plan"
        title={plan.title}
        description={plan.brief}
        meta={(
          <>
            <StatusBadge size="xs" tone={PLAN_STATUS_TONE[plan.status]}>
              {formatStatus(plan.status)}
            </StatusBadge>
            <span className="inline-flex min-w-0 items-center gap-bakin-2">
              {planAgentIdentity && <AgentAvatar agent={planAgentIdentity} size="xs" decorative />}
              <span>{planAgentIdentity?.name ?? plan.agent}</span>
            </span>
            <span>Target {formatDate(plan.targetDate)}</span>
          </>
        )}
        overflowActionsLabel="Plan actions"
        overflowActions={(
          <DropdownMenuItem
            variant="danger"
            onClick={() => {
              setDeleteError(null)
              setDeleteOpen(true)
            }}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        )}
      />

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PlanWorkspaceTab)}>
        <TabsList variant="underline" activateOnFocus aria-label="Plan workspace sections">
          {PLAN_WORKSPACE_TABS.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              id={`messaging-plan-tab-${item.id}`}
              aria-controls={`messaging-plan-panel-${item.id}`}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <PageBody className="min-h-0 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-bakin-6 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-bakin-6 overflow-y-auto @3xl/page-shell:flex-row @3xl/page-shell:overflow-hidden">
            <main className="flex min-h-0 min-w-0 flex-1 flex-col @3xl/page-shell:min-w-[360px]">
          {activeTab === 'plan' ? (
            <div
              id="messaging-plan-panel-plan"
              aria-labelledby="messaging-plan-tab-plan"
              className="min-h-0 flex-none overflow-visible [scrollbar-gutter:stable] @3xl/page-shell:flex-1 @3xl/page-shell:overflow-y-auto @3xl/page-shell:pr-bakin-2"
              role="tabpanel"
            >
              <section className="pb-5">
                {plan.status === 'needs_review' && (
                  <Alert tone="accent">
                    <div className="flex flex-wrap items-start justify-between gap-bakin-3">
                      <div className="min-w-0">
                        <AlertTitle className="inline-flex items-center gap-bakin-2">
                          <Info className="size-bakin-4" aria-hidden="true" />
                          Review this plan before work starts
                        </AlertTitle>
                        <AlertDescription>
                          Confirm the direction, pick channels, and add guidance in the brainstorm before kicking off content prep.
                        </AlertDescription>
                      </div>
                      {canKickoffContentPrep && selectedChannels.length > 0 && (
                        <Button onClick={startContentPrep} disabled={startingPrep || selectedChannels.length === 0}>
                          <Rocket className="size-bakin-4" data-icon="inline-start" />
                          {startingPrep ? 'Starting...' : 'Kickoff content prep'}
                        </Button>
                      )}
                    </div>
                  </Alert>
                )}

                <div className={plan.status === 'needs_review' ? 'mt-5' : ''}>
                  <div className="mb-bakin-2 flex items-center justify-between gap-bakin-3">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-bakin-2 gap-y-bakin-1">
                      <h2 className="text-bakin-typography-size-body font-bakin-typography-weight-semibold">Channels</h2>
                      {!channelsLocked && (
                        <span className="text-bakin-typography-size-meta text-bakin-text-muted">Select one or more channels</span>
                      )}
                    </div>
                    {savingChannels && <span className="text-bakin-typography-size-meta text-bakin-text-muted">Saving...</span>}
                  </div>
                  {!channelsLocked && plan.status === 'needs_review' && selectedChannels.length === 0 && (
                    <Alert tone="attention" className="mb-bakin-3">
                      <AlertDescription>
                        Select one or more channels below. You can also use Brainstorm to ask your agent to suggest channels and update the plan.
                      </AlertDescription>
                    </Alert>
                  )}
                  {channelsLocked && (
                    <div className="mt-bakin-3">
                      {planChannels.length === 0 ? (
                        <div className="rounded-bakin-control border border-dashed border-bakin-border-subtle p-bakin-3 text-bakin-typography-size-body text-bakin-text-muted">
                          No channels are linked.
                        </div>
                      ) : (
                        <ListRows variant="bordered" aria-label="Plan channels">
                          {planChannels.map((channel) => (
                            <ListRow key={channel.id} className="flex items-center gap-bakin-2 px-bakin-3 py-bakin-2 text-bakin-typography-size-meta text-bakin-text-muted">
                              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-bakin-2">
                                <DistributionChannelIcon channelId={channel.channel} className="size-3.5" />
                                <span className="font-bakin-typography-weight-medium text-bakin-text-primary">{getDistributionChannelOption(channel.channel).label}</span>
                                <span>{getContentTypeLabel(channel.contentType, contentTypes)}</span>
                                <span>{formatDateTime(channel.publishAt)}</span>
                              </div>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Delete ${channel.channel} channel`}
                                title={`Delete ${channel.channel} channel`}
                                onClick={() => {
                                  setChannelDeleteError(null)
                                  setChannelPendingDelete(channel)
                                }}
                              >
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </Button>
                            </ListRow>
                          ))}
                        </ListRows>
                      )}
                    </div>
                  )}
                  {!channelsLocked && (
                    channelOptions.length === 0 ? (
                      <div className="rounded-bakin-control border border-dashed border-bakin-border-subtle p-bakin-3 text-bakin-typography-size-body text-bakin-text-muted">
                        No channels are configured yet.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-bakin-2">
                        {channelOptions.map(channel => {
                          const selected = selectedChannels.includes(channel.id)
                          return (
                            <Button
                              key={channel.id}
                              variant={selected ? 'accent' : 'secondary'}
                              size="sm"
                              aria-pressed={selected}
                              disabled={savingChannels}
                              onClick={() => togglePlanChannel(channel.id)}
                              className={`gap-bakin-2 font-bakin-typography-weight-regular ${
                                selected
                                  ? 'bg-bakin-signal-accent/10 hover:bg-bakin-signal-accent/15'
                                  : 'text-bakin-text-muted hover:bg-bakin-surface-elevated hover:text-bakin-text-muted'
                              }`}
                            >
                              <DistributionChannelIcon channelId={channel.id} className="size-3.5" />
                              {channel.label}
                            </Button>
                          )
                        })}
                      </div>
                    )
                  )}
                  {kickoffError && (
                    <Alert tone="danger" className="mt-bakin-3">
                      <AlertDescription>{kickoffError}</AlertDescription>
                    </Alert>
                  )}
                </div>

              </section>

              <section className="flex flex-col gap-bakin-3">
                <div className="flex items-center justify-between gap-bakin-3">
                  <h3 className="text-bakin-typography-size-body font-bakin-typography-weight-semibold">Content Pieces</h3>
                  <Badge size="xs" variant="outline">
                    {contentPiecesLabel(nonProposedDeliverables.length)}
                  </Badge>
                </div>

                {nonProposedDeliverables.length === 0 ? (
                  <div className="rounded-bakin-control border border-dashed border-bakin-border-subtle p-bakin-4 text-bakin-typography-size-body text-bakin-text-muted">
                    No content pieces have been planned yet.
                  </div>
                ) : (
                  <ListRows variant="bordered" aria-label="Content pieces">
                    {nonProposedDeliverables.map((deliverable) => (
                      <ListRow key={deliverable.id} className="overflow-hidden p-0">
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedDeliverable(deliverable)}
                          className="block !h-auto w-full whitespace-normal rounded-none p-bakin-3 text-left font-bakin-typography-weight-regular hover:bg-bakin-surface-elevated"
                        >
                          <div className="flex items-start justify-between gap-bakin-3">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-bakin-2">
                                <h4 className="truncate text-bakin-typography-size-body font-bakin-typography-weight-medium">{deliverable.title}</h4>
                                <Badge size="xs" variant="outline">{deliverable.channel}</Badge>
                              </div>
                              <p className="mt-bakin-1 line-clamp-2 text-bakin-typography-size-meta text-bakin-text-muted">{deliverable.brief}</p>
                            </div>
                            <DeliverableStatusBadge status={deliverable.status} className="shrink-0" />
                          </div>
                          <div className="mt-bakin-2 flex flex-wrap gap-bakin-3 text-bakin-typography-size-meta text-bakin-text-muted">
                            <span>{deliverable.contentType}</span>
                            <span>{deliverable.tone}</span>
                            <span>{formatDateTime(deliverable.publishAt)}</span>
                          </div>
                        </Button>
                      </ListRow>
                    ))}
                  </ListRows>
                )}
              </section>
            </div>
          ) : (
            <div
              id="messaging-plan-panel-brainstorm"
              aria-labelledby="messaging-plan-tab-brainstorm"
              className="flex min-h-144 flex-1 flex-col @3xl/page-shell:min-h-0"
              role="tabpanel"
            >
              {plan.sourceSessionId ? (
                <div className="flex h-full min-h-0 flex-col gap-bakin-3">
                  {plan.status === 'needs_review' && (
                    <div className="shrink-0 rounded-bakin-control bg-bakin-surface-default p-bakin-3 text-bakin-typography-size-body text-bakin-text-muted">
                      Before content prep starts, refine the angle and channels here. A useful first note is which channels this message should use and anything the prep agents should avoid.
                    </div>
                  )}
                  <ConversationPanel
                    messages={brainstormMessages}
                    liveChunks={brainstorm.liveChunks}
                    streaming={brainstorm.streaming}
                    onSend={brainstorm.send}
                    onAbort={brainstorm.abort}
                    agent={conversationAgent}
                    storageKey={`messaging-plan:${plan.id}`}
                    placeholder="Refine the angle, channels, timeline, or content pieces..."
                    fitParent
                    showHeader={false}
                    className="rounded-none border-0"
                  />
                </div>
              ) : (
                <div className="rounded-bakin-control border border-dashed border-bakin-border-subtle p-bakin-4 text-bakin-typography-size-body text-bakin-text-muted">
                  Brainstorm refinements are available for plans prepared from a brainstorm session.
                </div>
              )}
            </div>
          )}
            </main>

            <aside
              className="relative w-full shrink-0 border-t border-bakin-border-subtle pt-bakin-6 @3xl/page-shell:w-[var(--plan-sidebar-width)] @3xl/page-shell:overflow-y-auto @3xl/page-shell:border-l @3xl/page-shell:border-t-0 @3xl/page-shell:pl-bakin-6 @3xl/page-shell:pr-bakin-2 @3xl/page-shell:pt-0"
              style={{
                '--plan-sidebar-width': `${sidebarWidth}px`,
                scrollbarGutter: 'stable',
              } as CSSProperties}
            >
          {/* Drag handle — sits over the left border to resize the sidebar.
              role / aria-orientation / tabIndex / aria-value* / keyboard all come from handleProps. */}
              <div
                {...sidebarResizeProps}
                aria-label="Resize details panel"
                className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-bakin-surface-elevated active:bg-bakin-border-subtle @3xl/page-shell:block"
              />
          <div>
            <h3 className="mb-bakin-3 text-bakin-typography-size-meta font-bakin-typography-weight-medium uppercase tracking-wider text-bakin-text-muted">Details</h3>
            <div className="space-y-bakin-2 text-bakin-typography-size-meta text-bakin-text-muted">
              <DetailRow
                label="Target"
                icon={<CalendarDays className="size-3.5" aria-hidden="true" />}
              >
                {formatDate(plan.targetDate)}
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(plan.createdAt)}</DetailRow>
              <DetailRow label="Updated">{formatDateTime(plan.updatedAt)}</DetailRow>
              <DetailRow label="Agent">
                <span className="inline-flex min-w-0 items-center gap-bakin-1">
                  {planAgentIdentity && <AgentAvatar agent={planAgentIdentity} size="xs" decorative />}
                  <span className="truncate">{planAgentIdentity?.name ?? plan.agent}</span>
                </span>
              </DetailRow>
              {plan.campaign && (
                <DetailRow label="Campaign">{plan.campaign}</DetailRow>
              )}
              <DetailRow label="Channels" align="start">
                {planChannels.length > 0 ? (
                  <div className="flex min-w-0 flex-wrap justify-end gap-bakin-1">
                    {planChannels.map((channel) => (
                      <Badge key={channel.id} size="xs" variant="outline" className="max-w-28 truncate">
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

          <div className="mt-5 border-t border-bakin-border-subtle pt-5">
            <div className="mb-bakin-2 flex items-center justify-between">
              <h3 className="text-bakin-typography-size-meta font-bakin-typography-weight-medium uppercase tracking-wider text-bakin-text-muted">Progress</h3>
              <span className="font-bakin-typography-family-mono text-bakin-typography-size-meta tabular-nums text-bakin-text-muted">{progress}%</span>
            </div>
            <Progress value={progress} aria-label="Plan progress" />
          </div>

          {canKickoffContentPrep && plan.status !== 'needs_review' && (
            <div className="mt-5 rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default p-bakin-3">
              <h3 className="text-bakin-typography-size-body font-bakin-typography-weight-semibold">Ready for content prep?</h3>
              <p className="mt-bakin-1 text-bakin-typography-size-meta text-bakin-text-muted">
                Kickoff creates one scheduled board task per configured channel.
              </p>
              <Button className="mt-bakin-3 w-full justify-center" onClick={startContentPrep} disabled={startingPrep || selectedChannels.length === 0}>
                <Rocket className="size-bakin-4" data-icon="inline-start" />
                {startingPrep ? 'Starting...' : 'Kickoff content prep'}
              </Button>
              {selectedChannels.length === 0 && <p className="mt-bakin-2 text-bakin-typography-size-meta text-bakin-text-muted">Choose at least one channel first.</p>}
            </div>
          )}

          <div className="mt-5 border-t border-bakin-border-subtle pt-5">
            <h3 className="mb-bakin-3 text-bakin-typography-size-meta font-bakin-typography-weight-medium uppercase tracking-wider text-bakin-text-muted">Tasks</h3>
            <div className="space-y-bakin-3">
              {planningTasks.map((task) => (
                <div key={task.title} className="flex gap-bakin-2">
                  <PlanningTaskIcon state={task.state} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-bakin-2">
                      <p className="text-bakin-typography-size-meta font-bakin-typography-weight-medium">{task.title}</p>
                      <Badge size="xs" variant="outline" className="shrink-0">
                        {TASK_STATE_LABELS[task.state]}
                      </Badge>
                    </div>
                    <p className="mt-bakin-1 text-bakin-typography-size-meta text-bakin-text-muted">{task.detail}</p>
                    <p className="mt-bakin-1 text-bakin-typography-size-meta text-bakin-text-muted">Target: {task.due}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 border-t border-bakin-border-subtle pt-5">
            <h3 className="mb-bakin-3 text-bakin-typography-size-meta font-bakin-typography-weight-medium uppercase tracking-wider text-bakin-text-muted">Plan Links</h3>
            <div className="space-y-bakin-2 text-bakin-typography-size-meta text-bakin-text-muted">
              {plan.sourceSessionId && (
                <div className="flex items-center gap-bakin-2">
                  <MessageSquareText className="size-3.5" aria-hidden="true" />
                  Source brainstorm
                  <Badge size="xs" variant="outline" className="ml-auto font-bakin-typography-family-mono">
                    {plan.sourceSessionId.slice(0, 8)}
                  </Badge>
                </div>
              )}
              {activeDeliverables.some((deliverable) => deliverable.taskId) && (
                <div className="flex items-center gap-bakin-2">
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  Board tasks linked
                  <Badge size="xs" variant="outline" className="ml-auto">
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
        </div>
      </PageBody>

      <DeliverableDrawer
        deliverable={selectedDeliverable}
        open={Boolean(selectedDeliverable)}
        onClose={() => setSelectedDeliverable(null)}
        onUpdated={refresh}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete this plan?"
        description="This removes the plan, its content pieces, and any linked board tasks created for this plan."
        confirmLabel="Delete plan"
        busyLabel="Deleting..."
        confirmTone="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={handleDeletePlan}
        onCancel={() => {
          if (deleting) return
          setDeleteError(null)
          setDeleteOpen(false)
        }}
      />

      <ConfirmDialog
        open={Boolean(channelPendingDelete)}
        title="Delete this channel?"
        description="This removes the channel from the plan and deletes its content pieces plus linked board tasks."
        confirmLabel="Delete channel"
        busyLabel="Deleting..."
        confirmTone="danger"
        busy={deletingChannel}
        error={channelDeleteError}
        onConfirm={handleDeleteChannel}
        onCancel={() => {
          if (deletingChannel) return
          setChannelDeleteError(null)
          setChannelPendingDelete(null)
        }}
      >
        {channelPendingDelete && (
          <p className="text-bakin-typography-size-meta text-bakin-text-muted">
            {channelPendingDelete.channel} · {getContentTypeLabel(channelPendingDelete.contentType, contentTypes)}
          </p>
        )}
      </ConfirmDialog>
    </Page>
  )
}
