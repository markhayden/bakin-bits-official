'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ConversationEmptyState, ConversationPanel, useConversationThread } from "@makinbakin/sdk/conversation"
import type { ConversationAgent, ConversationMessage } from "@makinbakin/sdk/conversation"
import { Panel } from "@makinbakin/sdk/layout"
import {
  AgentAvatar,
  ConfirmDialog,
  KeyValue,
  ListRow,
  ListRows,
  Page,
  PageBody,
  PageHeader,
  StatusBadge,
  Timeline,
  TimelineEntry,
} from "@makinbakin/sdk/patterns"
import type { KeyValueItem } from "@makinbakin/sdk/patterns"
import { emitPluginEvent, toast, useAgentList, useHorizontalResize, usePluginEvent } from "@makinbakin/sdk/hooks"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  DropdownMenuItem,
  Progress,
  Separator,
  Skeleton,
  SystemState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
} from "@makinbakin/sdk/ui"
import { ArrowLeft, CalendarDays, ExternalLink, FileText, Globe2, Info, Instagram, MessageCircle, MessageSquareText, Music2, Rocket, Slack, Trash2, Twitter, type LucideIcon } from 'lucide-react'
import type { BrainstormSession, ContentTypeOption, Deliverable, Plan, PlanChannel, PlanStatus } from '../types'
import { PLAN_STATUS_TONE } from '../constants'
import { sessionMessageToConversation } from '../lib/session-to-conversation'
import { setVisiblePlanSourceSession } from './brainstorm-badge-provider'
import { usePlan } from '../hooks/use-plan'
import { getContentTypeLabel, useContentTypes } from '../hooks/use-content-types'
import { getDistributionChannelDefinition, MESSAGING_DISTRIBUTION_CHANNELS } from '../lib/distribution-channels'
import { DeliverableDrawer } from './deliverable-drawer'
import { DeliverableStatusBadge } from './deliverable-status-badge'
import { formatDateTime } from '@makinbakin/sdk/utils'

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
const TASK_STATE_TONE: Record<PlanningTaskState, 'neutral' | 'success' | 'attention'> = {
  done: 'success',
  current: 'neutral',
  upcoming: 'neutral',
  needs_attention: 'attention',
}

/** Instant (ISO datetime) → the SDK's calendar-aware absolute time; unparseable → "Date to set". */
function formatInstant(value: string): string {
  if (Number.isNaN(new Date(value).getTime())) return 'Date to set'
  return formatDateTime(value)
}

/**
 * Plan target dates are date-only (`YYYY-MM-DD`) — a calendar day with no
 * instant. The SDK `formatDateTime` renders instants (and would read a bare
 * date as UTC midnight, shifting the day in western zones), so the day-only
 * formatter stays local. `formatRelativeDate` below adds an offset in days on
 * the same day-only basis.
 */
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

function DetailLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-bakin-2">
      {icon}
      {children}
    </span>
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
      meta={<Text as="code" mono>{planId}</Text>}
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
  // Watching refinements here counts as viewing the source session: the
  // badge provider suppresses toast/chime for it, and seen marks keep the
  // Brainstorm nav badge honest (review I3 — replies watched in the plan
  // workspace stayed "unread" forever).
  const markSourceSessionSeen = useCallback(() => {
    const sessionId = plan?.sourceSessionId
    if (!sessionId || document.visibilityState !== 'visible') return
    const encoded = encodeURIComponent(sessionId)
    void fetch(`/api/plugins/messaging/sessions/${encoded}/seen?id=${encoded}`, { method: 'POST' })
      .then(() => emitPluginEvent({ event: 'messaging.brainstorm.seen', sessionId }))
      .catch(() => {})
  }, [plan?.sourceSessionId])

  useEffect(() => {
    setVisiblePlanSourceSession(plan?.sourceSessionId ?? null)
    markSourceSessionSeen()
    return () => setVisiblePlanSourceSession(null)
  }, [plan?.sourceSessionId, markSourceSessionSeen])

  // Plan-refinement turns run server-side on the conversation turn engine
  // (bakin#703): they share the source session's transcript + bus events,
  // so navigation never kills a refinement and returning rehydrates it.
  const planIdRef = useRef(plan?.id)
  planIdRef.current = plan?.id
  const brainstorm = useConversationThread({
    threadKey: plan?.sourceSessionId ?? '',
    events: {
      chunk: 'messaging.brainstorm.chunk',
      done: 'messaging.brainstorm.done',
      error: 'messaging.brainstorm.error',
    },
    keyOf: useCallback((payload: Record<string, unknown>) => payload.sessionId, []),
    load: useCallback(async (key: string) => {
      const encoded = encodeURIComponent(key)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}?id=${encoded}`)
      if (!response.ok) return null
      const data = await response.json() as { session?: BrainstormSession; streaming?: boolean; streamingText?: string }
      if (!data.session) return null
      return {
        messages: data.session.messages.map((message) => sessionMessageToConversation(data.session!.agentId, message)).filter((m): m is ConversationMessage => m !== null),
        streaming: data.streaming === true,
        ...(typeof data.streamingText === 'string' ? { streamingText: data.streamingText } : {}),
      }
    }, []),
    post: useCallback(async (key: string, content: string) => {
      const encoded = encodeURIComponent(key)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}/messages?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, planId: planIdRef.current }),
      })
      if (response.ok) return { ok: true }
      const body = await response.json().catch(() => ({})) as { error?: string }
      return { ok: false, status: response.status, ...(body.error ? { error: String(body.error) } : {}) }
    }, []),
    onSettled: useCallback(() => {
      void refresh()
      markSourceSessionSeen()
    }, [refresh, markSourceSessionSeen]),
  })

  // Plan updates parsed from refinement replies ride the bus.
  usePluginEvent('messaging.brainstorm.plan_update', (payload) => {
    if (payload.sessionId === plan?.sourceSessionId) void refresh()
  })

  useEffect(() => {
    if (brainstorm.sendError) toast(brainstorm.sendError, 'error')
  }, [brainstorm.sendError])

  const abortBrainstorm = useCallback(() => {
    if (!plan?.sourceSessionId) return
    const encoded = encodeURIComponent(plan.sourceSessionId)
    void fetch(`/api/plugins/messaging/sessions/${encoded}/abort?id=${encoded}`, { method: 'POST' }).catch(() => {})
  }, [plan?.sourceSessionId])

  // "Try again" on an error turn re-sends the newest user message (chat parity).
  const retryBrainstorm = useCallback(() => {
    const lastUser = [...brainstorm.messages].reverse().find((m) => m.kind === 'user')
    if (lastUser?.kind === 'user' && lastUser.content) void brainstorm.send(lastUser.content)
  }, [brainstorm])

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

  const linkedTaskCount = activeDeliverables.filter((deliverable) => deliverable.taskId).length
  const detailItems: KeyValueItem[] = [
    {
      label: <DetailLabel icon={<CalendarDays className="size-3.5" aria-hidden="true" />}>Target</DetailLabel>,
      value: formatDate(plan.targetDate),
    },
    { label: 'Created', value: formatInstant(plan.createdAt) },
    { label: 'Updated', value: formatInstant(plan.updatedAt) },
    {
      label: 'Agent',
      value: (
        <span className="inline-flex min-w-0 items-center gap-bakin-1">
          {planAgentIdentity && <AgentAvatar agent={planAgentIdentity} size="xs" decorative />}
          <span className="truncate">{planAgentIdentity?.name ?? plan.agent}</span>
        </span>
      ),
    },
    ...(plan.campaign ? [{ label: 'Campaign', value: plan.campaign }] : []),
    {
      label: 'Channels',
      value: planChannels.length > 0 ? (
        <span className="flex min-w-0 flex-wrap justify-end gap-bakin-1">
          {planChannels.map((channel) => (
            <Badge key={channel.id} size="xs" variant="outline" className="max-w-28 truncate">
              {getDistributionChannelOption(channel.channel).label}
            </Badge>
          ))}
        </span>
      ) : 'Not set',
    },
  ]
  const planLinkItems: KeyValueItem[] = [
    ...(plan.sourceSessionId ? [{
      label: <DetailLabel icon={<MessageSquareText className="size-3.5" aria-hidden="true" />}>Source brainstorm</DetailLabel>,
      value: <Badge size="xs" variant="outline">{plan.sourceSessionId.slice(0, 8)}</Badge>,
      mono: true,
    }] : []),
    ...(linkedTaskCount > 0 ? [{
      label: <DetailLabel icon={<ExternalLink className="size-3.5" aria-hidden="true" />}>Board tasks linked</DetailLabel>,
      value: <Badge size="xs" variant="outline">{linkedTaskCount}</Badge>,
      numeric: true,
    }] : []),
  ]

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

      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as PlanWorkspaceTab)}
      >
        <TabsList variant="underline" activateOnFocus aria-label="Plan workspace sections" className="shrink-0">
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

      <PageBody className="min-h-0 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-bakin-6 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-bakin-6 overflow-y-auto @3xl/page-shell:flex-row @3xl/page-shell:overflow-hidden">
            <main className="flex min-h-0 min-w-0 flex-1 flex-col @3xl/page-shell:min-w-[360px]">
            <TabsContent
              value="plan"
              id="messaging-plan-panel-plan"
              aria-labelledby="messaging-plan-tab-plan"
              className="min-h-0 flex-none overflow-visible [scrollbar-gutter:stable] @3xl/page-shell:flex-1 @3xl/page-shell:overflow-y-auto @3xl/page-shell:pr-bakin-2"
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
                      <h2>Channels</h2>
                      {!channelsLocked && (
                        <Text as="span" size="meta" tone="muted">Select one or more channels</Text>
                      )}
                    </div>
                    {savingChannels && <Text as="span" size="meta" tone="muted">Saving...</Text>}
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
                        <SystemState kind="initial-empty" scope="inline" title="No channels are linked." />
                      ) : (
                        <ListRows variant="bordered" aria-label="Plan channels">
                          {planChannels.map((channel) => (
                            <ListRow key={channel.id} className="flex items-center gap-bakin-2 px-bakin-3 py-bakin-2">
                              <Text as="div" size="meta" tone="muted" className="flex min-w-0 flex-1 flex-wrap items-center gap-bakin-2">
                                <DistributionChannelIcon channelId={channel.channel} className="size-3.5" />
                                <Text as="span" size="meta" weight="medium">{getDistributionChannelOption(channel.channel).label}</Text>
                                <span>{getContentTypeLabel(channel.contentType, contentTypes)}</span>
                                <span>{formatInstant(channel.publishAt)}</span>
                              </Text>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Delete ${channel.channel} channel`}
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
                      <SystemState kind="initial-empty" scope="inline" title="No channels are configured yet." />
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
                            >
                              <DistributionChannelIcon channelId={channel.id} data-icon="inline-start" />
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
                  <h3>Content Pieces</h3>
                  <Badge size="xs" variant="outline">
                    {contentPiecesLabel(nonProposedDeliverables.length)}
                  </Badge>
                </div>

                {nonProposedDeliverables.length === 0 ? (
                  <SystemState kind="initial-empty" scope="inline" title="No content pieces have been planned yet." />
                ) : (
                  <ListRows variant="bordered" aria-label="Content pieces">
                    {nonProposedDeliverables.map((deliverable) => (
                      <ListRow
                        key={deliverable.id}
                        interactive={{ label: `Open ${deliverable.title}`, onActivate: () => setSelectedDeliverable(deliverable) }}
                        className="p-bakin-3"
                      >
                          <div className="flex items-start justify-between gap-bakin-3">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-bakin-2">
                                <Text as="h4" weight="medium" className="truncate">{deliverable.title}</Text>
                                <Badge size="xs" variant="outline">{deliverable.channel}</Badge>
                              </div>
                              <Text as="p" size="meta" tone="muted" className="mt-bakin-1 line-clamp-2">{deliverable.brief}</Text>
                            </div>
                            <DeliverableStatusBadge status={deliverable.status} className="shrink-0" />
                          </div>
                          <Text as="div" size="meta" tone="muted" className="mt-bakin-2 flex flex-wrap gap-bakin-3">
                            <span>{deliverable.contentType}</span>
                            <span>{deliverable.tone}</span>
                            <span>{formatInstant(deliverable.publishAt)}</span>
                          </Text>
                      </ListRow>
                    ))}
                  </ListRows>
                )}
              </section>
            </TabsContent>
            <TabsContent
              value="brainstorm"
              id="messaging-plan-panel-brainstorm"
              aria-labelledby="messaging-plan-tab-brainstorm"
              className="flex min-h-144 flex-1 flex-col @3xl/page-shell:min-h-0"
            >
              {plan.sourceSessionId ? (
                <div className="flex h-full min-h-0 flex-col gap-bakin-3">
                  {plan.status === 'needs_review' && (
                    <Alert tone="neutral" className="shrink-0">
                      <AlertDescription>
                        Before content prep starts, refine the angle and channels here. A useful first note is which channels this message should use and anything the prep agents should avoid.
                      </AlertDescription>
                    </Alert>
                  )}
                  <ConversationPanel
                    messages={brainstorm.messages}
                    liveChunks={brainstorm.liveChunks}
                    streaming={brainstorm.streaming}
                    onSend={brainstorm.send}
                    onAbort={abortBrainstorm}
                    onRetry={retryBrainstorm}
                    agent={conversationAgent}
                    storageKey={`messaging-plan:${plan.id}`}
                    placeholder="Refine the angle, channels, timeline, or content pieces..."
                    fitParent
                    showHeader={false}
                    className="rounded-none border-0"
                    emptyState={
                      <ConversationEmptyState
                        title="Refine this plan with its agent"
                        description="Suggested channel, timeline, or angle changes apply to the plan directly — a good first note is which channels to use and what to avoid."
                      />
                    }
                  />
                </div>
              ) : (
                <SystemState
                  kind="initial-empty"
                  scope="inline"
                  title="Brainstorm refinements are available for plans prepared from a brainstorm session."
                />
              )}
            </TabsContent>
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
            <h3 className="mb-bakin-3">Details</h3>
            <KeyValue layout="rows" items={detailItems} />
          </div>

          <Separator className="my-bakin-4" />
          <div>
            <div className="mb-bakin-2 flex items-center justify-between">
              <h3>Progress</h3>
              <Text as="span" size="meta" tone="muted" mono className="tabular-nums">{progress}%</Text>
            </div>
            <Progress value={progress} aria-label="Plan progress" />
          </div>

          {canKickoffContentPrep && plan.status !== 'needs_review' && (
            <Panel className="mt-5">
              <h3>Ready for content prep?</h3>
              <Text as="p" size="meta" tone="muted" className="mt-bakin-1">
                Kickoff creates one scheduled board task per configured channel.
              </Text>
              <Button className="mt-bakin-3 w-full justify-center" onClick={startContentPrep} disabled={startingPrep || selectedChannels.length === 0}>
                <Rocket data-icon="inline-start" aria-hidden="true" />
                {startingPrep ? 'Starting...' : 'Kickoff content prep'}
              </Button>
              {selectedChannels.length === 0 && (
                <Text as="p" size="meta" tone="muted" className="mt-bakin-2">Choose at least one channel first.</Text>
              )}
            </Panel>
          )}

          <Separator className="my-bakin-4" />
          <div>
            <h3 className="mb-bakin-3">Tasks</h3>
            <Timeline aria-label="Planning tasks">
              {planningTasks.map((task) => (
                <TimelineEntry
                  key={task.title}
                  tone={TASK_STATE_TONE[task.state]}
                  markerLabel={TASK_STATE_LABELS[task.state]}
                  timestamp={task.due}
                  title={task.title}
                  meta={(
                    <Badge size="xs" variant="outline" className="shrink-0">
                      {TASK_STATE_LABELS[task.state]}
                    </Badge>
                  )}
                >
                  {task.detail}
                </TimelineEntry>
              ))}
            </Timeline>
          </div>

          <Separator className="my-bakin-4" />
          <div>
            <h3 className="mb-bakin-3">Plan Links</h3>
            {planLinkItems.length > 0 ? (
              <KeyValue layout="rows" items={planLinkItems} />
            ) : (
              <Text as="p" size="meta" tone="muted">No linked sessions or board tasks yet.</Text>
            )}
          </div>
            </aside>
          </div>
        </div>
      </PageBody>
      </Tabs>

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
          <Text as="p" size="meta" tone="muted">
            {channelPendingDelete.channel} · {getContentTypeLabel(channelPendingDelete.contentType, contentTypes)}
          </Text>
        )}
      </ConfirmDialog>
    </Page>
  )
}
