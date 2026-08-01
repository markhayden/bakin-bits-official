'use client'

import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ConversationPanel } from "@makinbakin/sdk/conversation"
import type { ConversationAgent, ConversationMessage } from "@makinbakin/sdk/conversation"
import { useAgentIds, useAgentList, useHorizontalResize, useSearch } from "@makinbakin/sdk/hooks"
import { usePathname, useQueryState, useRouter, useSearchParams } from "@makinbakin/sdk/navigation"
import {
  AgentAvatar,
  AgentFilter,
  ConfirmDialog,
  ListRow,
  ListRows,
  Page,
  PageBody,
  PageControls,
  PageHeader,
  SearchInput,
  SegmentedControl,
  StatusBadge,
  WorkspacePage,
  WorkspacePageBody,
  WorkspacePageHeader,
} from "@makinbakin/sdk/patterns"
import {
  Badge,
  Drawer,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
  Input,
  SystemState,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@makinbakin/sdk/ui"
import { ArrowLeft, Check, ClipboardList, Columns2, Plus, SquareStack, Trash2, X } from 'lucide-react'
import type { BrainstormSession, PlanProposal, SessionMessage } from '../types'
import { useConversationStream } from '../hooks/use-conversation-stream'

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

interface AgentOption {
  id: string
  name: string
  imageSrc?: string | null
}

const PROPOSAL_PANEL_MIN_WIDTH = 360
const PROPOSAL_PANEL_MAX_WIDTH = 720
const PROPOSAL_PANEL_DEFAULT_WIDTH = 460
const PROPOSAL_PANEL_STORAGE_KEY = 'messaging-proposal-panel-width'
const BRAINSTORM_LAYOUT_STORAGE_KEY = 'messaging-brainstorm-layout'
const DELETE_REQUEST_TIMEOUT_MS = 10000

type BrainstormLayoutMode = 'columns' | 'tabs'
type BrainstormWorkspaceTab = 'brainstorm' | 'proposals'

function getStoredBrainstormLayoutMode(): BrainstormLayoutMode {
  if (typeof window === 'undefined') return 'columns'
  try {
    const stored = window.localStorage.getItem(BRAINSTORM_LAYOUT_STORAGE_KEY)
    if (stored === 'tabs' || stored === 'columns') return stored
    return window.matchMedia?.('(max-width: 767px)').matches ? 'tabs' : 'columns'
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

function toConversation(agentId: string, message: SessionMessage): ConversationMessage | null {
  if (message.role === 'user') {
    return { kind: 'user', ts: message.timestamp, content: message.content }
  }
  if (message.role === 'assistant') {
    return { kind: 'assistant', ts: message.timestamp, agentId, content: message.content }
  }
  // Activity rows: structured tool payloads render as tool rows; status
  // noise stays out of the durable timeline; errors render honestly.
  if (message.kind === 'tool_call') {
    const data = (message.data ?? {}) as { callId?: string; toolName?: string; status?: string; summary?: string; inputPreview?: string; outputPreview?: string; durationMs?: number }
    return {
      kind: 'tool',
      ts: message.timestamp,
      agentId,
      toolName: data.toolName ?? 'tool',
      status: data.status === 'failed' ? 'failed' : 'completed',
      ...(data.callId ? { callId: data.callId } : {}),
      summary: data.summary ?? message.content,
      ...(data.inputPreview ? { inputPreview: data.inputPreview } : {}),
      ...(data.outputPreview ? { outputPreview: data.outputPreview } : {}),
      ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
    }
  }
  if (message.kind === 'error') {
    return { kind: 'error', ts: message.timestamp, message: message.content }
  }
  return null
}

const BRAINSTORM_LAYOUT_OPTIONS = [
  { value: 'columns' as const, label: 'Columns', icon: Columns2 },
  { value: 'tabs' as const, label: 'Tabs', icon: SquareStack },
]

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
      <Badge size="xs" variant="outline" className="mt-bakin-2">
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
  const meta: Record<PlanProposal['status'], {
    label: string
    tone: 'neutral' | 'success' | 'attention' | 'danger' | 'accent'
  }> = {
    proposed: { label: 'Needs review', tone: 'attention' },
    approved: { label: 'Accepted', tone: 'success' },
    rejected: { label: 'Rejected', tone: 'danger' },
    revised: { label: 'Revised', tone: 'accent' },
  }
  const badge = meta[status]
  return (
    <StatusBadge className="max-w-28 shrink-0 truncate" size="xs" tone={badge.tone}>
      {badge.label}
    </StatusBadge>
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New brainstorm</DialogTitle>
        </DialogHeader>
        <form className="space-y-bakin-4" onSubmit={handleSubmit}>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Session title..."
            autoFocus
            disabled={creating}
          />
          <div className="space-y-bakin-2">
            <div className="text-bakin-typography-size-meta font-bakin-typography-weight-medium uppercase text-bakin-text-muted">Agent</div>
            <div className="grid max-h-56 gap-bakin-2 overflow-y-auto sm:grid-cols-2" role="radiogroup" aria-label="Brainstorm agent">
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
                    className={`flex min-w-0 items-center gap-bakin-2 rounded-bakin-control border px-bakin-3 py-bakin-2 text-left text-bakin-typography-size-body transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-bakin-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? 'border-bakin-signal-accent bg-bakin-signal-accent/10'
                        : 'border-bakin-border-subtle bg-bakin-surface-default hover:bg-bakin-surface-elevated'
                    }`}
                  >
                    <AgentAvatar
                      agent={{ id: agent.id, name: agent.name, imageSrc: agent.imageSrc ?? null }}
                      size="sm"
                      decorative
                    />
                    <span className="truncate font-bakin-typography-weight-medium">{agent.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
          {error && <p className="text-bakin-typography-size-meta text-bakin-signal-danger">{error}</p>}
          <div className="flex justify-end gap-bakin-2">
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
  const canReject = !proposal.planId && (proposal.status === 'proposed' || proposal.status === 'revised')
  const canAccept = !proposal.planId && proposal.status !== 'approved'
  const canCancelAcceptance = !proposal.planId && proposal.status === 'approved'
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
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      title={proposal.title}
      defaultWidth={520}
      storageKey="messaging-proposal-review"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pr-bakin-1">
          <div className="space-y-5 pb-5">
            <section className="rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default p-bakin-4">
              <ProposalStatusBadge proposal={proposal} />
              <p className="mt-bakin-3 text-bakin-typography-size-body text-bakin-text-muted">{proposal.brief}</p>
            </section>

            <section className="grid gap-bakin-4">
              <label className="grid gap-bakin-1 text-bakin-typography-size-body font-bakin-typography-weight-medium">
                Title
                <Input value={title} disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className="grid gap-bakin-1 text-bakin-typography-size-body font-bakin-typography-weight-medium">
                Target date
                <Input type="date" value={targetDate} disabled={disabled} onChange={(event) => setTargetDate(event.target.value)} />
              </label>
              <label className="grid gap-bakin-1 text-bakin-typography-size-body font-bakin-typography-weight-medium">
                Brief
                <Textarea
                  value={brief}
                  disabled={disabled}
                  onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setBrief(event.target.value)}
                  rows={6}
                  className="min-h-32"
                />
              </label>
              <label className="grid gap-bakin-1 text-bakin-typography-size-body font-bakin-typography-weight-medium">
                Suggested channels
                <div
                  className={`flex min-h-10 flex-wrap items-center gap-bakin-2 rounded-bakin-control border border-bakin-border-subtle bg-bakin-canvas-default px-bakin-2 py-bakin-1 text-bakin-typography-size-body outline-none transition-colors focus-within:outline-2 focus-within:outline-solid focus-within:-outline-offset-1 focus-within:outline-bakin-focus-ring ${
                    disabled ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  {channels.map(channel => (
                    <span
                      key={channel}
                      className="inline-flex h-7 max-w-full items-center gap-bakin-1 rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default px-bakin-2 text-bakin-typography-size-meta font-bakin-typography-weight-medium"
                    >
                      <span className="truncate">{channel}</span>
                      {!disabled && (
                        <button
                          type="button"
                          aria-label={`Remove ${channel}`}
                          onClick={() => removeChannel(channel)}
                          className="rounded-bakin-control text-bakin-text-muted transition-colors hover:text-bakin-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-bakin-focus-ring"
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
                    className="min-h-7 min-w-24 flex-1 bg-transparent px-bakin-1 text-bakin-typography-size-body outline-none placeholder:text-bakin-text-muted disabled:cursor-not-allowed"
                  />
                </div>
              </label>
              {!proposal.planId && (canReject || canAccept || canCancelAcceptance) && (
                <div className="flex flex-wrap items-center justify-end gap-bakin-2 pt-bakin-1">
                  {canCancelAcceptance && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => save('proposed')}
                      disabled={saving}
                    >
                      <X className="size-3.5" />
                      Cancel acceptance
                    </Button>
                  )}
                  {canReject && (
                    <Button
                      size="sm"
                      variant="danger"
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
          <div className="shrink-0 border-t border-bakin-border-subtle pt-bakin-4">
            <div>
              <Button className="w-full justify-center" variant="outline" onClick={() => save()} disabled={saving}>
                Save changes
              </Button>
            </div>
          </div>
        )}
      </div>
    </Drawer>
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
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [materializing, setMaterializing] = useState(false)
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<BrainstormLayoutMode>(getStoredBrainstormLayoutMode)
  const [compactWorkspace, setCompactWorkspace] = useState(() => (
    typeof window !== 'undefined'
      ? window.matchMedia?.('(max-width: 767px)').matches ?? false
      : false
  ))
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
    const mediaQuery = window.matchMedia?.('(max-width: 767px)')
    if (!mediaQuery) return

    const updateCompactWorkspace = (event?: MediaQueryListEvent) => {
      setCompactWorkspace(event?.matches ?? mediaQuery.matches)
    }
    updateCompactWorkspace()
    mediaQuery.addEventListener?.('change', updateCompactWorkspace)
    return () => mediaQuery.removeEventListener?.('change', updateCompactWorkspace)
  }, [])

  useEffect(() => {
    if (search) searchHook.search(search)
    else searchHook.clear()
  }, [search])

  const agentOptions = useMemo((): AgentOption[] => {
    const byId = new Map<string, AgentOption>()
    for (const agent of agentList) {
      if (!agent.id) continue
      byId.set(agent.id, {
        id: agent.id,
        name: agent.name ?? agent.id,
        imageSrc: agent.headshot ?? null,
      })
    }
    for (const id of agentIds) {
      if (!byId.has(id)) byId.set(id, { id, name: id === 'main' ? 'Main' : id })
    }
    return byId.size > 0 ? [...byId.values()] : [{ id: 'main', name: 'Main' }]
  }, [agentIds, agentList])

  const defaultNewSessionAgentId = agentOptions[0]?.id ?? 'main'
  const agentById = useMemo(
    () => new Map(agentOptions.map(agent => [agent.id, agent])),
    [agentOptions],
  )
  const agentFilterOptions = useMemo(
    () => agentOptions.map(agent => ({
      value: agent.id,
      label: agent.name,
      visual: (
        <AgentAvatar
          agent={{ id: agent.id, name: agent.name, imageSrc: agent.imageSrc ?? null }}
          size="sm"
          decorative
        />
      ),
    })),
    [agentOptions],
  )
  // The focused conversation kit never reads host stores — resolve the
  // session agent's identity here and hand it down presentation-ready.
  const sessionConversationAgent = useMemo<ConversationAgent | undefined>(() => {
    if (!activeSession) return undefined
    const agent = agentById.get(activeSession.agentId)
    return {
      id: activeSession.agentId,
      name: agent?.name ?? activeSession.agentId,
      ...(agent?.imageSrc ? { avatarUrl: agent.imageSrc } : {}),
    }
  }, [activeSession, agentById])

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
    setMessages(data.session.messages.map(message => toConversation(data.session!.agentId, message)).filter((m): m is ConversationMessage => m !== null))
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
      await loadSession(activeSession.id)
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
        setMessages([])
        pushSessionId('')
      }
      setDeleteSessionId(null)
      await loadSessions()
    } finally {
      window.clearTimeout(timeout)
      setDeletingSession(false)
    }
  }

  // The kit stream hook drives the live turn over the `chunk` SSE frames;
  // the `proposal` custom events keep the side panel in sync mid-stream.
  const brainstorm = useConversationStream({
    fetcher: useCallback((content: string, ctx: { signal: AbortSignal }) => {
      if (!activeSession) throw new Error('No active session')
      const encoded = encodeURIComponent(activeSession.id)
      return fetch(`/api/plugins/messaging/sessions/${encoded}/messages?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({ message: content }),
      })
    }, [activeSession]),
    onCustom: useCallback((event: string, data: unknown) => {
      if (event === 'proposal' && isRecord(data) && data.proposal) {
        const proposal = data.proposal as PlanProposal
        setActiveSession(current => current ? {
          ...current,
          proposals: mergeProposal(current.proposals, proposal),
        } : current)
      }
    }, []),
    onDone: useCallback(async () => {
      if (!activeSession) return
      await loadSession(activeSession.id)
      await loadSessions()
    }, [activeSession, loadSession, loadSessions]),
    onError: useCallback(async () => {
      if (!activeSession) return
      await loadSession(activeSession.id)
    }, [activeSession, loadSession]),
  })

  const sessionPendingDelete = deleteSessionId
    ? activeSession?.id === deleteSessionId
      ? activeSession
      : sessions.find(session => session.id === deleteSessionId)
    : null

  const deleteSessionDialog = sessionPendingDelete ? (
    <ConfirmDialog
      open
      title="Delete this brainstorm session?"
      description="This removes only the brainstorm. Plans already prepared from this session and their board tasks stay in place."
      confirmLabel="Delete session"
      busyLabel="Deleting..."
      confirmTone="danger"
      busy={deletingSession}
      onConfirm={deleteSession}
      onCancel={() => {
        if (deletingSession) return
        setDeleteSessionId(null)
      }}
    >
      <p className="truncate text-bakin-typography-size-meta text-bakin-text-muted">{sessionPendingDelete.title}</p>
    </ConfirmDialog>
  ) : null

  if (sessionId && activeSession) {
    const acceptedCount = activeSession.proposals.filter(proposal => proposal.status === 'approved').length
    const pendingPlanCount = activeSession.proposals.filter(
      proposal => proposal.status === 'approved' && !proposal.planId,
    ).length
    const canCompleteSession = activeSession.status === 'active' && acceptedCount > 0
    const selectedProposal = activeSession.proposals.find(proposal => proposal.id === selectedProposalId) ?? null
    const brainstormPane = (
      <div className="h-full min-h-0 min-w-0 overflow-hidden">
        <ConversationPanel
          messages={messages}
          liveChunks={brainstorm.liveChunks}
          streaming={brainstorm.streaming}
          onSend={brainstorm.send}
          onAbort={brainstorm.abort}
          agent={sessionConversationAgent}
          storageKey={`messaging:${activeSession.id}`}
          placeholder="Ask for content topics, campaign ideas, or revisions..."
          transformText={transformAssistantReply}
          readOnly={activeSession.status === 'archived'}
          readOnlyNotice={<Badge variant="outline">Archived session</Badge>}
          fitParent
          showHeader={false}
          className="rounded-none border-0"
        />
      </div>
    )
    const renderProposalPanel = ({ showHeader, showResizeHandle }: { showHeader: boolean; showResizeHandle: boolean }) => (
      <aside
        data-slot="brainstorm-proposal-panel"
        className={`relative flex min-h-0 w-full max-w-full min-w-0 flex-col overflow-hidden ${showHeader ? 'border-l border-bakin-border-subtle px-bakin-4 py-bakin-4' : ''}`}
      >
        {showResizeHandle && (
          <div
            aria-label="Resize proposal panel"
            className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-bakin-surface-elevated active:bg-bakin-border-subtle"
            {...proposalResizeProps}
          />
        )}
        {showHeader && (
          <div className="mb-bakin-3 flex items-center justify-between">
            <h2 className="text-bakin-typography-size-body font-bakin-typography-weight-semibold">Plan proposals</h2>
            <Badge size="xs" tone="neutral" variant="outline">{activeSession.proposals.length}</Badge>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {activeSession.proposals.length === 0 ? (
            <SystemState
              kind="initial-empty"
              scope="section"
              headingLevel={3}
              title="No proposals yet"
              description="Ask the agent to propose campaign ideas, then review them here."
              className="w-full max-w-full [&_[data-slot=system-state-copy]]:w-full [&_[data-slot=system-state-description]]:max-w-full [&_[data-slot=system-state-description]]:[overflow-wrap:anywhere]"
            />
          ) : (
            <div className="grid w-full max-w-full min-w-0 gap-bakin-2">
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
                  className="w-full max-w-full min-w-0 overflow-hidden rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default p-bakin-3 text-left transition-colors hover:bg-bakin-surface-elevated focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-bakin-focus-ring"
                >
                  <div className="flex items-start justify-between gap-bakin-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 text-bakin-typography-size-body font-bakin-typography-weight-medium">{proposal.title}</h3>
                      <p className="mt-bakin-1 text-bakin-typography-size-meta text-bakin-text-muted">{formatDate(proposal.targetDate)}</p>
                    </div>
                    <ProposalStatusBadge proposal={proposal} />
                  </div>
                  <p className="mt-bakin-2 line-clamp-3 text-bakin-typography-size-body text-bakin-text-muted">{proposal.brief}</p>
                  {proposal.suggestedChannels && proposal.suggestedChannels.length > 0 && (
                    <div className="mt-bakin-2 flex flex-wrap gap-bakin-1">
                      {proposal.suggestedChannels.map(channel => (
                        <Badge key={channel} size="xs" variant="outline">{channel}</Badge>
                      ))}
                    </div>
                  )}
                  {hasInlineProposalActions(proposal) && (
                    <div className="mt-bakin-3 flex flex-wrap items-center justify-end gap-bakin-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        className="px-bakin-3"
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
                        className="px-bakin-3"
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
        {activeSession.status === 'active' && (
          <div className="mt-bakin-3 shrink-0 border-t border-bakin-border-subtle pt-bakin-3">
            <Button className="w-full justify-center" disabled={!canCompleteSession || materializing} onClick={materialize}>
              <ClipboardList className="size-4" />
              {pendingPlanCount > 0 ? 'Complete session and prepare plans' : 'Complete session'}
            </Button>
          </div>
        )}
      </aside>
    )
    const tabbedWorkspace = (
      <div
        data-slot="brainstorm-tabbed-workspace"
        className="flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col overflow-hidden"
      >
        <Tabs
          className="shrink-0"
          value={workspaceTab}
          onValueChange={(value) => setWorkspaceTab(value as BrainstormWorkspaceTab)}
        >
          <TabsList
            variant="underline"
            activateOnFocus
            aria-label="Brainstorm layout sections"
            className="px-bakin-4 pt-bakin-2"
          >
            {[
              { id: 'brainstorm', label: 'Brainstorm' },
              { id: 'proposals', label: `Plan proposals (${activeSession.proposals.length})` },
            ].map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                id={`brainstorm-workspace-tab-${item.id}`}
                aria-controls={`brainstorm-workspace-panel-${item.id}`}
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {workspaceTab === 'brainstorm' ? (
          <div
            id="brainstorm-workspace-panel-brainstorm"
            className="min-h-0 w-full max-w-full min-w-0 flex-1"
            role="tabpanel"
            aria-labelledby="brainstorm-workspace-tab-brainstorm"
          >
            {brainstormPane}
          </div>
        ) : (
          <div
            id="brainstorm-workspace-panel-proposals"
            className="min-h-0 w-full max-w-full min-w-0 flex-1 overflow-hidden p-bakin-4"
            role="tabpanel"
            aria-labelledby="brainstorm-workspace-tab-proposals"
          >
            {renderProposalPanel({ showHeader: false, showResizeHandle: false })}
          </div>
        )}
      </div>
    )
    const effectiveLayoutMode: BrainstormLayoutMode = compactWorkspace ? 'tabs' : layoutMode
    const workspace = effectiveLayoutMode === 'columns' ? (
      <div
        data-testid="brainstorm-workspace-columns"
        className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${proposalPanelWidth}px` }}
      >
        {brainstormPane}
        {renderProposalPanel({ showHeader: true, showResizeHandle: true })}
      </div>
    ) : tabbedWorkspace

    return (
      <WorkspacePage className="w-full max-w-full min-w-0">
        <WorkspacePageHeader className="w-full max-w-full min-w-0 overflow-hidden">
          <PageHeader
            eyebrow="Messaging / Brainstorm"
            title={activeSession.title}
            description="Develop ideas with an agent, review its proposed plans, and prepare the directions you accept."
            navigation={(
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Back to brainstorm sessions"
                title="Back to brainstorm sessions"
                onClick={() => pushSessionId('')}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
            )}
            meta={(
              <Badge size="xs" tone="neutral" variant="outline">
                {activeSession.proposals.length} {activeSession.proposals.length === 1 ? 'proposal' : 'proposals'}
              </Badge>
            )}
            controls={(
              <div className="hidden md:block">
                <SegmentedControl
                  ariaLabel="Brainstorm workspace layout"
                  options={BRAINSTORM_LAYOUT_OPTIONS}
                  value={layoutMode}
                  onValueChange={changeLayoutMode}
                />
              </div>
            )}
            overflowActionsLabel="Brainstorm actions"
            overflowActions={(
              <DropdownMenuItem
                variant="danger"
                onClick={() => setDeleteSessionId(activeSession.id)}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            )}
          />
        </WorkspacePageHeader>

        <WorkspacePageBody className="w-full max-w-full min-w-0 border-t border-bakin-border-subtle">
          {workspace}
        </WorkspacePageBody>

        <ProposalDrawer
          proposal={selectedProposal}
          open={Boolean(selectedProposal)}
          onClose={() => setSelectedProposalId(null)}
          onUpdate={updateProposal}
        />
        {deleteSessionDialog}
      </WorkspacePage>
    )
  }

  const clearSessionFilters = () => {
    setSearch('')
    setAgentFilter('all')
  }
  const sessionState = sessionsLoading ? (
    <SystemState
      kind="loading"
      scope="page"
      title="Loading brainstorms"
      description="Your recent idea sessions will appear here when they are ready."
    />
  ) : sessions.length === 0 ? (
    <SystemState
      kind="initial-empty"
      scope="page"
      title="No brainstorm sessions yet"
      description="Start a session with an agent to develop campaign ideas and prepare plans."
      action={(
        <Button onClick={() => setNewSessionOpen(true)}>
          <Plus data-icon="inline-start" />
          New brainstorm
        </Button>
      )}
    />
  ) : visibleSessions.length === 0 ? (
    <SystemState
      kind="no-results"
      scope="page"
      title="No brainstorms match this view"
      description="Clear the current search and agent filter to return to every session."
      action={<Button variant="outline" onClick={clearSessionFilters}>Clear filters</Button>}
    />
  ) : undefined

  return (
    <Page>
      <PageHeader
        title="Brainstorm"
        description="Develop ideas with an agent, revisit recent sessions, and turn accepted directions into campaign plans."
        meta={(
          <Badge size="xs" tone="neutral" variant="outline">
            {visibleSessions.length} shown
          </Badge>
        )}
        controls={(
          <SearchInput
            align="end"
            label="Search brainstorm sessions"
            value={search}
            onValueChange={setSearch}
            placeholder="Search brainstorms…"
            mobileFullWidth
            className="@3xl/page-header:w-[22rem] @3xl/page-header:shrink-0"
          />
        )}
        actions={(
          <Button
            onClick={() => {
              setCreateError(null)
              setNewSessionOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            New brainstorm
          </Button>
        )}
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

      <PageControls label="Brainstorm filters">
        <AgentFilter
          options={agentFilterOptions}
          value={agentFilter}
          onValueChange={setAgentFilter}
          compact
        />
      </PageControls>

      <PageBody label="Brainstorm sessions" state={sessionState}>
        {!sessionState ? (
          <ListRows variant="bordered" aria-label="Brainstorm sessions">
            {visibleSessions.map(session => {
              const agent = agentById.get(session.agentId)
              return (
              <ListRow key={session.id} className="overflow-hidden p-0">
                <Button
                  variant="ghost"
                  onClick={() => pushSessionId(session.id)}
                  className="block !h-auto w-full whitespace-normal rounded-none px-bakin-4 py-bakin-3 text-left font-bakin-typography-weight-regular hover:bg-bakin-surface-elevated"
                >
                  <div className="flex min-w-0 items-start gap-bakin-3">
                    <AgentAvatar
                      agent={{
                        id: session.agentId,
                        name: agent?.name ?? session.agentId,
                        imageSrc: agent?.imageSrc ?? null,
                      }}
                      size="md"
                      decorative
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-bakin-2">
                        <h2 className="min-w-0 truncate text-bakin-typography-size-body font-bakin-typography-weight-semibold text-bakin-text-primary">
                          {session.title}
                        </h2>
                        <StatusBadge
                          size="xs"
                          tone={session.status === 'active' ? 'success' : 'neutral'}
                          className="capitalize"
                        >
                          {session.status}
                        </StatusBadge>
                      </div>
                      <p className="mt-bakin-1 text-bakin-typography-size-meta text-bakin-text-muted">
                        {agent?.name ?? session.agentId} · {session.proposalCount} proposals · {session.approvedCount} accepted
                      </p>
                    </div>
                  </div>
                </Button>
              </ListRow>
              )
            })}
          </ListRows>
        ) : null}
      </PageBody>
      {deleteSessionDialog}
    </Page>
  )
}
