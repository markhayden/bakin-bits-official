'use client'

/**
 * BrainstormBadgeProvider — chat-parity attention for messaging brainstorm
 * turns (bakin#703), mounted alongside PlansBadgeProvider in the host's
 * `nav-badge-providers` slot. Working dot on the Brainstorm nav item while
 * a turn runs, unread count (sessions with unseen agent activity) from
 * GET /brainstorm/attention, toast + chime + OS notification when a reply
 * lands while the user is elsewhere. The brainstorm view marks sessions
 * seen (`?session=` query — the visible key lives in the query string).
 */
import { useConversationAttention, AgentAvatar } from '@makinbakin/sdk/components'
import { useAgent, useRouter } from '@makinbakin/sdk/hooks'

/**
 * The session whose turns are on screen. Two surfaces qualify: the
 * brainstorm view (`?session=` in the URL) and the plan workspace (which
 * runs refinement turns for its plan's SOURCE session — resolved from
 * plan data, not the URL, so the workspace publishes it via a global the
 * provider reads at event time).
 */
export function setVisiblePlanSourceSession(sessionId: string | null): void {
  ;(globalThis as Record<string, unknown>).__messagingVisiblePlanSession = sessionId ?? undefined
}

function visibleSessionId(): string {
  const planSession = (globalThis as Record<string, unknown>).__messagingVisiblePlanSession
  if (typeof planSession === 'string' && planSession) return planSession
  if (!window.location.pathname.startsWith('/messaging/brainstorm')) return ''
  return new URLSearchParams(window.location.search).get('session') ?? ''
}

function ReplyToast({ sessionId, agentId, preview, onNavigate }: {
  sessionId: string
  agentId: string
  preview?: string
  onNavigate?: () => void
}) {
  const agent = useAgent(agentId)
  const router = useRouter()
  return (
    <button
      type="button"
      data-messaging-brainstorm-toast={sessionId}
      onClick={() => {
        onNavigate?.()
        router.push(`/messaging/brainstorm?session=${encodeURIComponent(sessionId)}`)
      }}
      className="flex max-w-sm items-start gap-2 text-left"
    >
      <AgentAvatar agentId={agentId} size="xs" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{agent?.name ?? agentId} replied in a brainstorm</span>
        {preview ? <span className="block truncate text-xs text-muted-foreground">{preview}</span> : null}
      </span>
    </button>
  )
}

export function BrainstormBadgeProvider() {
  useConversationAttention({
    pluginId: 'messaging',
    navItemId: 'messaging-brainstorm',
    events: {
      chunk: 'messaging.brainstorm.chunk',
      done: 'messaging.brainstorm.done',
      error: 'messaging.brainstorm.error',
      refresh: ['messaging.brainstorm.seen'],
    },
    keyOf: (payload) => String(payload.sessionId ?? ''),
    visibleKey: visibleSessionId,
    refreshTotals: async () => {
      const res = await fetch('/api/plugins/messaging/brainstorm/attention')
      if (!res.ok) return null
      const body = (await res.json()) as { unreadTotal?: number; inflight?: string[] }
      return { unreadTotal: body.unreadTotal ?? 0, inflightKeys: body.inflight ?? [] }
    },
    renderToast: (done, dismiss) => (
      <ReplyToast sessionId={done.key} agentId={done.agentId} preview={done.preview} onNavigate={dismiss} />
    ),
    osNotification: (done) => ({
      title: `${done.agentId} replied`,
      body: done.preview ?? '',
      href: `/messaging/brainstorm?session=${encodeURIComponent(done.key)}`,
    }),
    errorToast: (payload) => `Brainstorm turn failed: ${String(payload.message ?? 'unknown error')}`,
  })

  return null
}
