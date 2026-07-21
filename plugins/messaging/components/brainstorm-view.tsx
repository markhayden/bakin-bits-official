'use client'

import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  AgentAvatar,
  AgentFilter,
  BakinDrawer,
  ConversationPanel,
  EmptyState,
  PluginHeader,
  useConversationThread,
} from "@makinbakin/sdk/components"
import type { ConversationMessage } from "@makinbakin/sdk/components"
import { emitPluginEvent, toast, useAgentIds, useAgentList, useHorizontalResize, usePathname, useQueryState, usePluginEvent, useRouter, useSearch, useSearchParams } from "@makinbakin/sdk/hooks"
import { Badge } from "@makinbakin/sdk/ui"
import { Button } from "@makinbakin/sdk/ui"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@makinbakin/sdk/ui"
import { Input } from "@makinbakin/sdk/ui"
import { ArrowLeft, CalendarDays, Check, ClipboardList, Columns2, Plus, SquareStack, Trash2, X } from 'lucide-react'
import type { BrainstormSession, PlanProposal } from '../types'
import { sessionMessageToConversation } from '../lib/session-to-conversation'

interface SessionSummary {
  id: string
  agentId: string
  title: string
  status: BrainstormSession['status']
  createdAt: string
  updatedAt: string
  proposalCount: number
  approvedCount: number
  unread: boolean
  streaming: boolean
}

interface AgentOption {
  id: string
  name: string
}

const PROPOSAL_PANEL_MIN_WIDTH = 360
const PROPOSAL_PANEL_MAX_WIDTH = 720
const PROPOSAL_PANEL_DEFAULT_WIDTH = 460
const PROPOSAL_PANEL_STORAGE_KEY = 'messaging-proposal-panel-width'
const BRAINSTORM_LAYOUT_STORAGE_KEY = 'messaging-brainstorm-layout'
const DELETE_REQUEST_TIMEOUT_MS = 10000
const REJECT_BUTTON_CLASS = 'border-red-500/50 text-red-400 hover:border-red-400 hover:bg-red-500/10 hover:text-red-300'

type BrainstormLayoutMode = 'columns' | 'tabs'
type BrainstormWorkspaceTab = 'brainstorm' | 'proposals'

function getStoredBrainstormLayoutMode(): BrainstormLayoutMode {
  if (typeof window === 'undefined') return 'columns'
  try {
    return window.localStorage.getItem(BRAINSTORM_LAYOUT_STORAGE_KEY) === 'tabs' ? 'tabs' : 'columns'
  } catch {
    return 'columns'
  }
}

function persistBrainstormLayoutMode(mode: BrainstormLayoutMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(BRAINSTORM_LAYOUT_STORAGE_KEY, mode)
  } catch {
    // Layout switching should continue to work even if localStorage is unavailable.
  }
}


function BrainstormLayoutToggle({
  value,
  onChange,
}: {
  value: BrainstormLayoutMode
  onChange: (mode: BrainstormLayoutMode) => void
}) {
  const options = [
    { id: 'columns' as const, label: 'Columns', ariaLabel: 'Columns layout', icon: Columns2 },
    { id: 'tabs' as const, label: 'Tabs', ariaLabel: 'Tabs layout', icon: SquareStack },
  ]

  return (
    <div className="inline-flex h-8 items-center overflow-hidden rounded-md border border-border bg-surface" aria-label="Brainstorm layout">
      {options.map((option) => {
        const Icon = option.icon
        const selected = value === option.id
        return (
          <button
            key={option.id}
            type="button"
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            title={option.label}
            onClick={() => onChange(option.id)}
            className={`inline-flex h-full items-center gap-1.5 px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
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

function NewBrainstormSessionDialog({
  open,
  agents,
  defaultAgentId,
  creating,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean
  agents: AgentOption[]
  defaultAgentId: string
  creating: boolean
  error: string | null
  onConfirm: (input: { title: string; agentId: string }) => void | Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [agentId, setAgentId] = useState(defaultAgentId)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setAgentId(defaultAgentId)
  }, [defaultAgentId, open])

  const trimmedTitle = title.trim()
  const selectedAgentId = agentId || defaultAgentId

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmedTitle || creating) return
    void onConfirm({ title: trimmedTitle, agentId: selectedAgentId })
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !creating) onCancel() }}>
      <DialogContent className="max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle>New brainstorm</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Session title..."
            autoFocus
            disabled={creating}
          />
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase text-muted-foreground">Agent</div>
            <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2" role="radiogroup" aria-label="Brainstorm agent">
              {agents.map(agent => {
                const selected = agent.id === selectedAgentId
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={creating}
                    onClick={() => setAgentId(agent.id)}
                    className={`flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected ? 'border-emerald-500/70 bg-emerald-500/10' : 'border-border bg-surface hover:bg-muted/40'
                    }`}
                  >
                    <AgentAvatar agentId={agent.id} size="sm" />
                    <span className="truncate font-medium">{agent.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmedTitle || creating}>
              {creating ? 'Creating...' : 'Create Session'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function hasInlineProposalActions(proposal: PlanProposal): boolean {
  return !proposal.planId && (proposal.status === 'proposed' || proposal.status === 'revised')
}

function parseChannelInput(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map(channel => channel.trim())
    .filter(Boolean)
}

function addUniqueChannels(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map(channel => channel.toLowerCase()))
  const next = [...existing]
  for (const channel of incoming) {
    const key = channel.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push(channel)
  }
  return next
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
  const [channels, setChannels] = useState<string[]>([])
  const [channelDraft, setChannelDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!proposal) return
    setTitle(proposal.title)
    setTargetDate(proposal.targetDate)
    setBrief(proposal.brief)
    setChannels(addUniqueChannels([], proposal.suggestedChannels ?? []))
    setChannelDraft('')
  }, [proposal])

  if (!proposal) return null

  const disabled = Boolean(proposal.planId || saving)
  const canReject = !proposal.planId && proposal.status !== 'rejected'
  const canAccept = !proposal.planId && proposal.status !== 'approved'
  const commitChannelDraft = () => {
    const parsed = parseChannelInput(channelDraft)
    if (parsed.length === 0) {
      setChannelDraft('')
      return
    }
    setChannels(current => addUniqueChannels(current, parsed))
    setChannelDraft('')
  }
  const removeChannel = (channel: string) => {
    setChannels(current => current.filter(item => item !== channel))
  }
  const handleChannelChange = (value: string) => {
    if (/[,\n]/.test(value)) {
      setChannels(current => addUniqueChannels(current, parseChannelInput(value)))
      setChannelDraft('')
      return
    }
    setChannelDraft(value)
  }
  const handleChannelKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commitChannelDraft()
      return
    }
    if (event.key === 'Backspace' && channelDraft === '' && channels.length > 0) {
      setChannels(current => current.slice(0, -1))
    }
  }
  const handleChannelPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!/[,\n]/.test(text)) return
    event.preventDefault()
    setChannels(current => addUniqueChannels(current, parseChannelInput(text)))
    setChannelDraft('')
  }
  const currentChannels = () => addUniqueChannels(channels, parseChannelInput(channelDraft))
  const save = async (status?: PlanProposal['status']) => {
    setSaving(true)
    try {
      await onUpdate(proposal, {
        title: title.trim() || proposal.title,
        targetDate: targetDate.trim() || proposal.targetDate,
        brief: brief.trim() || proposal.brief,
        suggestedChannels: currentChannels(),
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
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-5 pb-5">
            <section className="rounded-md border border-border bg-surface p-4">
              <ProposalStatusBadge proposal={proposal} />
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
                <div
                  className={`flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 ${
                    disabled ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  {channels.map(channel => (
                    <span
                      key={channel}
                      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs font-medium"
                    >
                      <span className="truncate">{channel}</span>
                      {!disabled && (
                        <button
                          type="button"
                          aria-label={`Remove ${channel}`}
                          onClick={() => removeChannel(channel)}
                          className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </span>
                  ))}
                  <input
                    value={channelDraft}
                    disabled={disabled}
                    onBlur={commitChannelDraft}
                    onChange={(event) => handleChannelChange(event.target.value)}
                    onKeyDown={handleChannelKeyDown}
                    onPaste={handleChannelPaste}
                    placeholder={channels.length === 0 ? 'instagram, blog, youtube' : ''}
                    aria-label="Suggested channels"
                    className="min-h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                  />
                </div>
              </label>
              {!proposal.planId && (canReject || canAccept) && (
                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  {canReject && (
                    <Button
                      size="sm"
                      variant="outline"
                      className={REJECT_BUTTON_CLASS}
                      onClick={() => save('rejected')}
                      disabled={saving}
                    >
                      <X className="size-3.5" />
                      Decline
                    </Button>
                  )}
                  {canAccept && (
                    <Button size="sm" onClick={() => save('approved')} disabled={saving}>
                      <Check className="size-3.5" />
                      Accept
                    </Button>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>

        {!proposal.planId && (
          <div className="shrink-0 border-t border-border bg-background/95 pt-4">
            <div>
              <Button className="w-full justify-center" variant="outline" onClick={() => save()} disabled={saving}>
                Save changes
              </Button>
            </div>
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
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<BrainstormSession | null>(null)
  const [materializing, setMaterializing] = useState(false)
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<BrainstormLayoutMode>(getStoredBrainstormLayoutMode)
  const [workspaceTab, setWorkspaceTab] = useState<BrainstormWorkspaceTab>('brainstorm')
  const { width: proposalPanelWidth, handleProps: proposalResizeProps } = useHorizontalResize({
    defaultWidth: PROPOSAL_PANEL_DEFAULT_WIDTH,
    minWidth: PROPOSAL_PANEL_MIN_WIDTH,
    maxWidth: PROPOSAL_PANEL_MAX_WIDTH,
    storageKey: PROPOSAL_PANEL_STORAGE_KEY,
  })
  const searchHook = useSearch({ plugin: 'messaging', facets: ['status', 'agent_id'], debounce: 300 })

  const changeLayoutMode = useCallback((mode: BrainstormLayoutMode) => {
    setLayoutMode(mode)
    persistBrainstormLayoutMode(mode)
  }, [])

  useEffect(() => {
    if (search) searchHook.search(search)
    else searchHook.clear()
  }, [search])

  const agentOptions = useMemo((): AgentOption[] => {
    const byId = new Map<string, AgentOption>()
    for (const agent of agentList) {
      if (!agent.id) continue
      byId.set(agent.id, { id: agent.id, name: agent.name ?? agent.id })
    }
    for (const id of agentIds) {
      if (!byId.has(id)) byId.set(id, { id, name: id === 'main' ? 'Main' : id })
    }
    return byId.size > 0 ? [...byId.values()] : [{ id: 'main', name: 'Main' }]
  }, [agentIds, agentList])

  const defaultNewSessionAgentId = agentOptions[0]?.id ?? 'main'

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

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // Keep the per-row unread/working indicators live: settles and seen
  // writes refresh; the first chunk of a NEW turn refreshes once so the
  // working dot appears without waiting for settle.
  usePluginEvent('messaging.brainstorm.done', () => { void loadSessions() })
  usePluginEvent('messaging.brainstorm.error', () => { void loadSessions() })
  usePluginEvent('messaging.brainstorm.seen', () => { void loadSessions() })
  usePluginEvent('messaging.brainstorm.chunk', (payload) => {
    const id = String(payload.sessionId ?? '')
    if (id && !sessions.some(s => s.id === id && s.streaming)) void loadSessions()
  })

  useEffect(() => {
    if (!sessionId) setActiveSession(null)
  }, [sessionId])

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

  const createSession = async ({ title, agentId }: { title: string; agentId: string }) => {
    setCreating(true)
    setCreateError(null)
    try {
      const response = await fetch('/api/plugins/messaging/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, title }),
      })
      if (!response.ok) {
        setCreateError('Could not create this brainstorm.')
        return
      }
      const data = await response.json() as { session?: BrainstormSession }
      setNewSessionOpen(false)
      await loadSessions()
      if (data.session) pushSessionId(data.session.id)
    } finally {
      setCreating(false)
    }
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
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}/materialize?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) return
      await brainstorm.refresh()
      await loadSessions()
      router.push('/messaging/plans')
    } finally {
      setMaterializing(false)
    }
  }

  const deleteSession = async () => {
    if (!deleteSessionId) return
    setDeletingSession(true)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), DELETE_REQUEST_TIMEOUT_MS)
    try {
      const encoded = encodeURIComponent(deleteSessionId)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}?id=${encoded}`, {
        method: 'DELETE',
        signal: controller.signal,
      })
      if (!response.ok) return
      if (sessionId === deleteSessionId) {
        setActiveSession(null)
        pushSessionId('')
      }
      setDeleteSessionId(null)
      await loadSessions()
    } finally {
      window.clearTimeout(timeout)
      setDeletingSession(false)
    }
  }

  // Turns run server-side on the conversation turn engine (bakin#703): the
  // kit hook echoes the user's message instantly, streams over the
  // messaging.brainstorm.* bus events (navigation never kills a turn), and
  // rehydrates mid-stream on return via the server-seeded streaming flag.
  const markSessionSeen = useCallback((id: string) => {
    const encoded = encodeURIComponent(id)
    void fetch(`/api/plugins/messaging/sessions/${encoded}/seen?id=${encoded}`, { method: 'POST' })
      .then(() => emitPluginEvent({ event: 'messaging.brainstorm.seen', sessionId: id }))
      .catch(() => {})
  }, [])

  const brainstorm = useConversationThread({
    threadKey: sessionId ?? '',
    events: {
      chunk: 'messaging.brainstorm.chunk',
      done: 'messaging.brainstorm.done',
      error: 'messaging.brainstorm.error',
    },
    keyOf: useCallback((payload: Record<string, unknown>) => payload.sessionId, []),
    load: useCallback(async (key: string) => {
      const encoded = encodeURIComponent(key)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}?id=${encoded}`)
      if (!response.ok) {
        setActiveSession(null)
        if (response.status === 404) {
          // Stale deep link (old toast/notification) — say so and return to
          // the list instead of a silent empty view with the param stuck.
          toast('That brainstorm session no longer exists', 'error')
          pushSessionId('')
        }
        return null
      }
      const data = await response.json() as { session?: BrainstormSession; streaming?: boolean; streamingText?: string }
      if (!data.session) return null
      setActiveSession(data.session)
      return {
        messages: data.session.messages.map(message => sessionMessageToConversation(data.session!.agentId, message)).filter((m): m is ConversationMessage => m !== null),
        streaming: data.streaming === true,
        ...(typeof data.streamingText === 'string' ? { streamingText: data.streamingText } : {}),
      }
    }, [pushSessionId]),
    post: useCallback(async (key: string, content: string) => {
      const encoded = encodeURIComponent(key)
      const response = await fetch(`/api/plugins/messaging/sessions/${encoded}/messages?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content }),
      })
      if (response.ok) return { ok: true }
      const body = await response.json().catch(() => ({})) as { error?: string }
      return { ok: false, status: response.status, ...(body.error ? { error: String(body.error) } : {}) }
    }, []),
    onSettled: useCallback(() => {
      void loadSessions()
      if (sessionId) markSessionSeen(sessionId)
    }, [loadSessions, markSessionSeen, sessionId]),
  })

  // Proposals parsed mid-stream ride the bus; keep the side panel live.
  usePluginEvent('messaging.brainstorm.proposal', (payload) => {
    if (payload.sessionId !== sessionId) return
    if (isRecord(payload.proposal)) {
      const proposal = payload.proposal as unknown as PlanProposal
      setActiveSession(current => current ? {
        ...current,
        proposals: mergeProposal(current.proposals, proposal),
      } : current)
    }
  })

  // Viewing a session marks it seen (clears the nav badge unread).
  useEffect(() => {
    if (sessionId) markSessionSeen(sessionId)
  }, [markSessionSeen, sessionId])

  // Send failures (409 busy, network) surface as a toast; the optimistic
  // row stays visible.
  useEffect(() => {
    if (brainstorm.sendError) toast(brainstorm.sendError, 'error')
  }, [brainstorm.sendError])

  const abortBrainstorm = useCallback(() => {
    if (!sessionId) return
    const encoded = encodeURIComponent(sessionId)
    void fetch(`/api/plugins/messaging/sessions/${encoded}/abort?id=${encoded}`, { method: 'POST' }).catch(() => {})
  }, [sessionId])

  // "Try again" on an error turn re-sends the newest user message (chat parity).
  const retryBrainstorm = useCallback(() => {
    const lastUser = [...brainstorm.messages].reverse().find((m) => m.kind === 'user')
    if (lastUser?.kind === 'user' && lastUser.content) void brainstorm.send(lastUser.content)
  }, [brainstorm])

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
          This removes only the brainstorm. Plans already prepared from this session and their board tasks stay in place.
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
    const brainstormPane = (
      <div className="min-h-0">
        <ConversationPanel
          messages={brainstorm.messages}
          liveChunks={brainstorm.liveChunks}
          streaming={brainstorm.streaming}
          onSend={brainstorm.send}
          onAbort={abortBrainstorm}
          onRetry={retryBrainstorm}
          agentId={activeSession.agentId}
          storageKey={`messaging:${activeSession.id}`}
          placeholder="Ask for content topics, campaign ideas, or revisions..."
          transformText={transformAssistantReply}
          readOnly={activeSession.status === 'archived'}
          readOnlyNotice={<Badge variant="outline">Archived session</Badge>}
          fitParent
          showHeader={false}
          emptyState={
            <div className="px-6 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Brainstorm content ideas with this agent</p>
              <p className="mt-1">
                Proposals the agent suggests land in the side panel for review — approve the good
                ones and materialize them into Plans. Try "plan next week's posts" or "give me five
                topic ideas for the launch".
              </p>
            </div>
          }
        />
      </div>
    )
    const renderProposalPanel = ({ showHeader, showResizeHandle }: { showHeader: boolean; showResizeHandle: boolean }) => (
      <aside className={`relative flex min-h-0 flex-col overflow-hidden ${showHeader ? 'border-l border-border px-4' : ''}`}>
        {showResizeHandle && (
          <div
            aria-label="Resize proposal panel"
            className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-accent/50 active:bg-accent"
            {...proposalResizeProps}
          />
        )}
        {showHeader && (
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Plan proposals</h2>
            <Badge variant="outline" className="text-[11px]">{activeSession.proposals.length}</Badge>
          </div>
        )}
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
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={`px-3 ${REJECT_BUTTON_CLASS}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          updateProposal(proposal, { status: 'rejected' })
                        }}
                      >
                        <X className="size-3.5" data-icon="inline-start" />
                        Decline
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="px-3"
                        onClick={(event) => {
                          event.stopPropagation()
                          updateProposal(proposal, { status: 'approved' })
                        }}
                      >
                        <Check className="size-3.5" data-icon="inline-start" />
                        Accept
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
    )
    const workspace = layoutMode === 'columns' ? (
      <div
        data-testid="brainstorm-workspace-columns"
        className="mt-4 grid min-h-0 flex-1 gap-4 overflow-hidden"
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${proposalPanelWidth}px` }}
      >
        {brainstormPane}
        {renderProposalPanel({ showHeader: true, showResizeHandle: true })}
      </div>
    ) : (
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 border-b border-border" role="tablist" aria-label="Brainstorm layout sections">
          {[
            { id: 'brainstorm' as const, label: 'Brainstorm' },
            { id: 'proposals' as const, label: 'Plan proposals' },
          ].map((tab) => {
            const selected = workspaceTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setWorkspaceTab(tab.id)}
                className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  selected
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>{tab.label}</span>
                {tab.id === 'proposals' && (
                  <Badge variant="outline" className="ml-1 text-[11px]">
                    {activeSession.proposals.length}
                  </Badge>
                )}
              </button>
            )
          })}
        </div>
        {workspaceTab === 'brainstorm' ? (
          <div className="min-h-0 flex-1 pt-4" role="tabpanel" aria-label="Brainstorm">
            {brainstormPane}
          </div>
        ) : (
          <div className="min-h-0 flex-1 pt-4" role="tabpanel" aria-label="Plan proposals">
            {renderProposalPanel({ showHeader: false, showResizeHandle: false })}
          </div>
        )}
      </div>
    )

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
                <div className="flex items-center gap-2">
                  <BrainstormLayoutToggle value={layoutMode} onChange={changeLayoutMode} />
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
                </div>
              }
            />
          </div>
        </div>

        {workspace}

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
          <Button
            size="sm"
            onClick={() => {
              setCreateError(null)
              setNewSessionOpen(true)
            }}
          >
            <Plus className="size-3.5" data-icon="inline-start" />
            New
          </Button>
        }
      />

      <NewBrainstormSessionDialog
        open={newSessionOpen}
        agents={agentOptions}
        defaultAgentId={defaultNewSessionAgentId}
        creating={creating}
        error={createError}
        onConfirm={createSession}
        onCancel={() => {
          setCreateError(null)
          setNewSessionOpen(false)
        }}
      />

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
                      {session.streaming ? (
                        <span data-testid="session-streaming" title="Reply in progress" className="h-2 w-2 shrink-0 rounded-full bg-sky-400 animate-pulse" />
                      ) : session.unread ? (
                        <span data-testid="session-unread" title="Unseen reply" className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                      ) : null}
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
