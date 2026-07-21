'use client'

/**
 * BrainstormBadgeProvider — mounted via the host's `nav-badge-providers`
 * slot (bakin#703), so it runs on every page. The kit's
 * useConversationAttention supplies chat-parity mechanics: working dot on
 * the Projects nav item while a brainstorm turn runs, unread count after
 * replies land unseen, toast + chime + OS notification when a reply
 * arrives while the user is elsewhere (viewing the project stays silent —
 * the detail page marks it seen).
 */
import { useConversationAttention, visibleIdFromLocation, ConversationReplyToast } from '@makinbakin/sdk/components'

export function BrainstormBadgeProvider() {
  useConversationAttention({
    pluginId: 'projects',
    navItemId: 'projects',
    events: {
      chunk: 'projects.brainstorm.chunk',
      done: 'projects.brainstorm.done',
      error: 'projects.brainstorm.error',
      // Fires after a seen write lands — the authoritative moment to drop
      // the unread count (the chat pattern).
      refresh: ['projects.brainstorm.seen'],
    },
    keyOf: (payload) => String(payload.projectId ?? ''),
    // Both /projects/<id> AND /projects/<id>/edit render the detail (and
    // its brainstorm) — a reply while editing must not toast/chime.
    visibleKey: () => {
      const pathname = window.location.pathname
      return (
        visibleIdFromLocation(pathname, '/projects', { exclude: ['new'] }) ||
        (pathname.endsWith('/edit')
          ? visibleIdFromLocation(pathname.slice(0, -'/edit'.length), '/projects', { exclude: ['new'] })
          : '')
      )
    },
    refreshTotals: async () => {
      const res = await fetch('/api/plugins/projects/brainstorm/attention')
      if (!res.ok) return null
      const body = (await res.json()) as { unreadTotal?: number; inflight?: string[] }
      return { unreadTotal: body.unreadTotal ?? 0, inflightKeys: body.inflight ?? [] }
    },
    renderToast: (done, dismiss) => (
      <ConversationReplyToast
        agentId={done.agentId}
        title="replied in a project brainstorm"
        preview={done.preview}
        to={`/projects/${encodeURIComponent(done.key)}`}
        onNavigate={dismiss}
        testId={{ attr: 'data-project-brainstorm-toast', value: done.key }}
      />
    ),
    osNotification: (done) => ({
      title: `${done.agentId} replied`,
      body: done.preview ?? '',
      href: `/projects/${encodeURIComponent(done.key)}`,
    }),
    errorToast: (payload) => `Project brainstorm failed: ${String(payload.message ?? 'unknown error')}`,
  })

  return null
}
