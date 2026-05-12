'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AgentAvatar,
  AgentFilter,
  BakinDrawer,
  EmptyState,
  IntegratedBrainstorm,
  PluginHeader,
  readBrainstormSseResponse,
} from "@bakin/sdk/components"
import type { BrainstormMessage } from "@bakin/sdk/components"
import { useAgentIds, useAgentList, usePathname, useQueryState, useRouter, useSearch, useSearchParams } from "@bakin/sdk/hooks"
import { Badge } from "@bakin/sdk/ui"
import { Button } from "@bakin/sdk/ui"
import { Input } from "@bakin/sdk/ui"
import { ArrowLeft, CalendarDays, Check, ClipboardList, Plus, Trash2, X } from 'lucide-react'
import type { BrainstormSession, PlanProposal, SessionMessage } from '../types'

interface SessionSummary {
  id: string
  agentId: string
  title: string
  status: BrainstormSession['status']
  createdAt: string
  updatedAt: string
  proposalCount: number
  approvedCount: number
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function transformAssistantReply(raw: string): { text: string; extras?: ReactNode } {
  let proposalCount = 0
  const complete = raw.match(/```json\s*\n[\s\S]*?```/g)
  if (complete) {
    for (const block of complete) {
      try {
        const jsonStr = block.replace(/^```json\s*\n/, '').replace(/```$/, '').trim()
        const parsed = JSON.parse(jsonStr)
        proposalCount += Array.isArray(parsed) ? parsed.length : 1
      } catch {
        proposalCount += 1
      }
    }
  }
  const text = raw
    .split(/```json[\s\S]*?```/)
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n\n')
  return {
    text,
    extras: proposalCount > 0 ? (
      <Badge variant="outline" className="mt-2 text-[10px]">
        {proposalCount} {proposalCount === 1 ? 'Plan' : 'Plans'} proposed
      </Badge>
    ) : undefined,
  }
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function mergeProposal(proposals: PlanProposal[], incoming: PlanProposal): PlanProposal[] {
  const existing = proposals.findIndex(proposal => proposal.id === incoming.id)
  if (existing === -1) return [...proposals, incoming]
  return proposals.map(proposal => proposal.id === incoming.id ? incoming : proposal)
}

function ProposalStatusBadge({ proposal }: { proposal: PlanProposal }) {
  const status = proposal.planId ? 'approved' : proposal.status
  const meta: Record<PlanProposal['status'], { label: string; className: string }> = {
    proposed: { label: 'Needs review', className: 'bg-amber-500/20 text-amber-300' },
    approved: { label: 'Accepted', className: 'bg-emerald-500/20 text-emerald-300' },
    rejected: { label: 'Rejected', className: 'bg-red-500/20 text-red-400' },
    revised: { label: 'Revised', className: 'bg-sky-500/20 text-sky-300' },
  }
  const badge = meta[status]
  return (
    <Badge className={`max-w-28 shrink-0 truncate ${badge.className}`}>
      {badge.label}
    </Badge>
  )
}

function hasInlineProposalActions(proposal: PlanProposal): boolean {
  return !proposal.planId && (proposal.status === 'proposed' || proposal.status === 'revised')
}

function ProposalDrawer({
  proposal,
  open,
  onClose,
  onUpdate,
}: {
  proposal: PlanProposal | null
  open: boolean
  onClose: () => void
  onUpdate: (proposal: PlanProposal, patch: Partial<PlanProposal>) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [brief, setBrief] = useState('')
  const [channels, setChannels] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!proposal) return
    setTitle(proposal.title)
    setTargetDate(proposal.targetDate)
    setBrief(proposal.brief)
    setChannels((proposal.suggestedChannels ?? []).join(', '))
  }, [proposal])

  if (!proposal) return null

  const disabled = Boolean(proposal.planId || saving)
  const canReject = !proposal.planId && proposal.status !== 'rejected'
  const canAccept = !proposal.planId && proposal.status !== 'approved'
  const save = async (status?: PlanProposal['status']) => {
    setSaving(true)
    try {
      await onUpdate(proposal, {
        title: title.trim() || proposal.title,
        targetDate: targetDate.trim() || proposal.targetDate,
        brief: brief.trim() || proposal.brief,
        suggestedChannels: channels.split(',').map(channel => channel.trim()).filter(Boolean),
        ...(status ? { status } : {}),
      })
      if (status) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <BakinDrawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      title={proposal.title}
      defaultWidth={520}
      storageKey="messaging-proposal-review"
      actions={
        <div className="flex items-center gap-2">
          {!proposal.planId && (
            <>
              {canReject && (
                <Button variant="outline" onClick={() => save('rejected')} disabled={saving}>
                  <X className="size-4" />
                  Reject
                </Button>
              )}
              {canAccept && (
                <Button onClick={() => save('approved')} disabled={saving}>
                  <Check className="size-4" />
                  Accept
                </Button>
              )}
            </>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <section className="rounded-md border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ProposalStatusBadge proposal={proposal} />
            {proposal.suggestedChannels?.map(channel => (
              <Badge key={channel} variant="outline">{channel}</Badge>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{proposal.brief}</p>
        </section>

        <section className="grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Title
            <Input value={title} disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Target date
            <Input type="date" value={targetDate} disabled={disabled} onChange={(event) => setTargetDate(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Brief
            <textarea
              value={brief}
              disabled={disabled}
              onChange={(event) => setBrief(event.target.value)}
              rows={6}
              className="min-h-32 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Suggested channels
            <Input
              value={channels}
              disabled={disabled}
              onChange={(event) => setChannels(event.target.value)}
              placeholder="instagram, blog, youtube"
            />
          </label>
        </section>

        {!proposal.planId && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" onClick={() => save()} disabled={saving}>
              Save changes
            </Button>
            {canReject && (
              <Button variant="outline" onClick={() => save('rejected')} disabled={saving}>
                <X className="size-4" />
                Reject
              </Button>
            )}
            {canAccept && (
              <Button onClick={() => save('approved')} disabled={saving}>
                <Check className="size-4" />
                Accept
              </Button>
            )}
          </div>
        )}
      </div>
    </BakinDrawer>
  )
}

export function BrainstormView() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const agentList = useAgentList()
  const agentIds = useAgentIds()
  const sessionId = searchParams.get('session') ?? ''

  const [search, setSearch] = useQueryState('q', '')
  const [agentFilter, setAgentFilter] = useQueryState('agent', 'all')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAgent, setNewAgent] = useState('')
  const [activeSession, setActiveSession] = useState<BrainstormSession | null>(null)
  const [messages, setMessages] = useState<BrainstormMessage[]>([])
  const [materializing, setMaterializing] = useState(false)
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)
  const searchHook = useSearch({ plugin: 'messaging', facets: ['status', 'agent_id'], debounce: 300 })

  useEffect(() => {
    if (search) searchHook.search(search)
    else searchHook.clear()
  }, [search])

  useEffect(() => {
    setNewAgent(current => current || agentIds[0] || agentList[0]?.id || 'main')
  }, [agentIds, agentList])

  const pushSessionId = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('session', id)
    else params.delete('session')
    router.push(`${pathname}?${params.toString()}`)
  }, [pathname, router, searchParams])

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const response = await fetch('/api/plugins/messaging/sessions')
      if (!response.ok) return
      const data = await response.json() as { sessions?: SessionSummary[] }
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const loadSession = useCallback(async (id: string) => {
    const encoded = encodeURIComponent(id)
    const response = await fetch(`/api/plugins/messaging/sessions/${encoded}?id=${encoded}`)
    if (!response.ok) {
      setActiveSession(null)
      setMessages([])
      return
    }
    const data = await response.json() as { session?: BrainstormSession }
    if (!data.session) return
    setActiveSession(data.session)
    setMessages(data.session.messages.map(message => toBrainstorm(data.session!.agentId, message)))
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (sessionId) loadSession(sessionId)
    else {
      setActiveSession(null)
      setMessages([])
    }
  }, [loadSession, sessionId])

  const visibleSessions = useMemo(() => {
    let rows = sessions
    if (agentFilter !== 'all') rows = rows.filter(session => session.agentId === agentFilter)
    if (search.trim()) {
      if (searchHook.results.length > 0) {
        const ids = new Set(searchHook.results.map(result => result.id.replace(/^brainstorm-/, '')))
        rows = rows.filter(session => ids.has(session.id))
      } else if (!searchHook.loading) {
        const query = search.toLowerCase()
        rows = rows.filter(session =>
          session.title.toLowerCase().includes(query) ||
          session.agentId.toLowerCase().includes(query)
        )
      }
    }
    return rows
  }, [agentFilter, search, searchHook.loading, searchHook.results, sessions])

  const createSession = async () => {
    const agentId = newAgent || agentIds[0] || agentList[0]?.id || 'main'
    const title = newTitle.trim() || 'New brainstorm session'
    const response = await fetch('/api/plugins/messaging/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, title }),
    })
    if (!response.ok) return
    const data = await response.json() as { session?: BrainstormSession }
    setCreating(false)
    setNewTitle('')
    await loadSessions()
    if (data.session) pushSessionId(data.session.id)
  }

  const updateProposal = async (proposal: PlanProposal, patch: Partial<PlanProposal>) => {
    if (!activeSession) return
    const sessionEncoded = encodeURIComponent(activeSession.id)
    const proposalEncoded = encodeURIComponent(proposal.id)
    const response = await fetch(`/api/plugins/messaging/sessions/${sessionEncoded}/proposals/${proposalEncoded}?id=${sessionEncoded}&proposalId=${proposalEncoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!response.ok) return
    const data = await response.json() as { proposal?: PlanProposal }
    if (data.proposal) {
      setActiveSession(current => current ? {
        ...current,
        proposals: mergeProposal(current.proposals, data.proposal!),
      } : current)
    }
  }

  const materialize = async () => {
    if (!activeSession) return
    setMaterializing(true)
    try {
      const encoded = encodeURIComponent(activeSession.id)
      await fetch(`/api/plugins/messaging/sessions/${encoded}/materialize?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      await loadSession(activeSession.id)
      await loadSessions()
    } finally {
      setMaterializing(false)
    }
  }

  const deleteSession = async () => {
    if (!deleteSessionId) return
    setDeletingSession(true)
    try {
      const encoded = encodeURIComponent(deleteSessionId)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}?id=${encoded}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteCreatedPlans: true, deleteLinkedTasks: true }),
      })
      if (!response.ok) return
      if (sessionId === deleteSessionId) {
        setActiveSession(null)
        setMessages([])
        pushSessionId('')
      }
      setDeleteSessionId(null)
      await loadSessions()
    } finally {
      setDeletingSession(false)
    }
  }

  const onSend = useCallback(async (
    prompt: string,
    _history: BrainstormMessage[],
    ctx: { signal: AbortSignal; onToken: (text: string) => void; onCustom?: (name: string, data: unknown) => void },
  ): Promise<{ content: string }> => {
    if (!activeSession) return { content: '' }
    const encoded = encodeURIComponent(activeSession.id)
    const response = await fetch(`/api/plugins/messaging/sessions/${encoded}/messages?id=${encoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctx.signal,
      body: JSON.stringify({ message: prompt }),
    })
    const result = await readBrainstormSseResponse(response, ctx, {
      onCustomEvent: (event, data) => {
        if (event === 'proposal' && isRecord(data) && data.proposal) {
          const proposal = data.proposal as PlanProposal
          setActiveSession(current => current ? {
            ...current,
            proposals: mergeProposal(current.proposals, proposal),
          } : current)
          ctx.onCustom?.('proposal', proposal)
          return true
        }
        return false
      },
    })
    await loadSession(activeSession.id)
    await loadSessions()
    return result
  }, [activeSession, loadSession, loadSessions])

  const sessionPendingDelete = deleteSessionId
    ? activeSession?.id === deleteSessionId
      ? activeSession
      : sessions.find(session => session.id === deleteSessionId)
    : null

  const deleteSessionDialog = sessionPendingDelete ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !deletingSession && setDeleteSessionId(null)} />
      <div className="relative w-[420px] rounded-md border border-border bg-background p-5 shadow-2xl">
        <h2 className="text-sm font-semibold">Delete this brainstorm session?</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This removes the brainstorm, any plans prepared from accepted proposals, and linked board tasks for those plans.
        </p>
        <p className="mt-3 truncate text-xs text-muted-foreground">{sessionPendingDelete.title}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={deletingSession} onClick={() => setDeleteSessionId(null)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deletingSession} onClick={deleteSession}>
            {deletingSession ? 'Deleting...' : 'Delete session'}
          </Button>
        </div>
      </div>
    </div>
  ) : null

  if (sessionId && activeSession) {
    const approvedCount = activeSession.proposals.filter(proposal => proposal.status === 'approved' && !proposal.planId).length
    const selectedProposal = activeSession.proposals.find(proposal => proposal.id === selectedProposalId) ?? null
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 shrink-0 p-0"
            aria-label="Back to sessions"
            title="Back to sessions"
            onClick={() => pushSessionId('')}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <div className="min-w-0 flex-1">
            <PluginHeader
              title={activeSession.title}
              count={activeSession.proposals.length}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-red-400"
                  aria-label="Delete brainstorm session"
                  title="Delete brainstorm session"
                  onClick={() => setDeleteSessionId(activeSession.id)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          </div>
        </div>

        <div className="mt-4 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,34vw)]">
          <div className="min-h-0">
            <IntegratedBrainstorm
              messages={messages}
              onMessagesChange={setMessages}
              onSend={onSend}
              agentId={activeSession.agentId}
              placeholder="Ask for content topics, campaign ideas, or revisions..."
              transformAssistantMessage={transformAssistantReply}
              readOnly={activeSession.status === 'archived'}
              readOnlyNotice={<Badge variant="outline">Archived session</Badge>}
              fitParent
              showHeader={false}
            />
          </div>

          <aside className="flex min-h-0 flex-col overflow-hidden border-l border-border px-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Plan proposals</h2>
              <Badge variant="outline" className="text-[11px]">{activeSession.proposals.length}</Badge>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
              {activeSession.proposals.length === 0 ? (
                <EmptyState icon={ClipboardList} title="No proposals yet" />
              ) : (
                <div className="grid gap-2">
                  {activeSession.proposals.map(proposal => (
                    <article
                      key={proposal.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedProposalId(proposal.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedProposalId(proposal.id)
                        }
                      }}
                      className="w-full overflow-hidden rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-muted/30 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="line-clamp-2 text-sm font-medium">{proposal.title}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">{formatDate(proposal.targetDate)}</p>
                        </div>
                        <ProposalStatusBadge proposal={proposal} />
                      </div>
                      <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{proposal.brief}</p>
                      {proposal.suggestedChannels && proposal.suggestedChannels.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {proposal.suggestedChannels.map(channel => (
                            <Badge key={channel} variant="outline" className="text-[10px]">{channel}</Badge>
                          ))}
                        </div>
                      )}
                      {hasInlineProposalActions(proposal) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="px-3"
                            onClick={(event) => {
                              event.stopPropagation()
                              updateProposal(proposal, { status: 'approved' })
                            }}
                          >
                            <Check className="size-3.5" data-icon="inline-start" />
                            Accept
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="px-3"
                            onClick={(event) => {
                              event.stopPropagation()
                              updateProposal(proposal, { status: 'rejected' })
                            }}
                          >
                            <X className="size-3.5" data-icon="inline-start" />
                            Reject
                          </Button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <Button className="w-full justify-center" disabled={approvedCount === 0 || materializing} onClick={materialize}>
                <ClipboardList className="size-4" />
                Complete session and prepare plans
              </Button>
            </div>
          </aside>
        </div>

        <ProposalDrawer
          proposal={selectedProposal}
          open={Boolean(selectedProposal)}
          onClose={() => setSelectedProposalId(null)}
          onUpdate={updateProposal}
        />
        {deleteSessionDialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PluginHeader
        title="Brainstorm"
        count={visibleSessions.length}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search sessions...',
        }}
        actions={
          <Button size="sm" onClick={() => setCreating(value => !value)}>
            <Plus className="size-3.5" data-icon="inline-start" />
            New Session
          </Button>
        }
      />

      {creating && (
        <div className="mt-4 grid gap-3 rounded-md border border-border bg-card p-3 md:grid-cols-[180px_minmax(0,1fr)_auto]">
          <select
            value={newAgent}
            onChange={(event) => setNewAgent(event.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
            aria-label="Brainstorm agent"
          >
            {(agentList.length > 0 ? agentList : agentIds.map(id => ({ id, name: id }))).map(agent => (
              <option key={agent.id} value={agent.id}>{agent.name ?? agent.id}</option>
            ))}
          </select>
          <Input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="Session title"
            aria-label="Brainstorm session title"
          />
          <Button onClick={createSession}>Create</Button>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <AgentFilter agentIds={agentIds} value={agentFilter} onChange={setAgentFilter} />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {sessionsLoading ? (
          <p className="text-sm text-muted-foreground">Loading sessions...</p>
        ) : visibleSessions.length === 0 ? (
          <EmptyState icon={CalendarDays} title="No brainstorm sessions" />
        ) : (
          <div className="grid gap-2">
            {visibleSessions.map(session => (
              <button
                key={session.id}
                type="button"
                onClick={() => pushSessionId(session.id)}
                className="w-full rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <AgentAvatar agentId={session.agentId} size="xs" />
                      <h2 className="truncate text-sm font-medium">{session.title}</h2>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {session.proposalCount} proposals, {session.approvedCount} accepted
                    </p>
                  </div>
                  <Badge className="capitalize">{session.status}</Badge>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {deleteSessionDialog}
    </div>
  )
}
