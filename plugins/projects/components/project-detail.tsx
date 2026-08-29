'use client'

import { useState, useCallback, useMemo, useEffect, useRef, type CSSProperties } from 'react'
import { emitPluginEvent, toast, useHorizontalResize, usePluginEvent } from '@makinbakin/sdk/hooks'
import { ArrowLeft, Paperclip, X, FileText, Image, Film, Music, File, ChevronDown, Pencil, Trash2, Link2 } from 'lucide-react'
import { useAgentList, useMainAgentId } from "@makinbakin/sdk/hooks"
import { PluginLink, useRouter } from "@makinbakin/sdk/navigation"
import { ConversationEmptyState, ConversationPanel, useConversationThread } from "@makinbakin/sdk/conversation"
import type { ConversationAgent, ConversationMessage } from "@makinbakin/sdk/conversation"
import {
  AgentSelect,
  AssetPicker,
  ConfirmDialog,
  KeyValue,
  ListRow,
  ListRowActions,
  ListRows,
  Page,
  PageHeader,
  SegmentedControl,
  StatusBadge,
  StatusMarker,
} from "@makinbakin/sdk/patterns"
import type { AssetPickerCollection } from "@makinbakin/sdk/patterns"
import { ProjectChecklist } from './project-checklist'
import { ProjectEditor } from './project-editor'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
  Progress,
  Separator,
  Skeleton,
  Switch,
  SystemState,
  Text,
  buttonVariants,
} from "@makinbakin/sdk/ui"
import { PlanHistoryPanel } from './plan-history'
import { RenderedPlan } from './rendered-plan'
import type { ProjectStatus } from '../types'
import { formatAge, formatDateTime } from '@makinbakin/sdk/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolvedAsset {
  assetId: string
  label?: string
  type: string
  description?: string
  tags?: string[]
  missing?: boolean
}

interface ProjectData {
  id: string
  title: string
  status: ProjectStatus
  owner: string
  progress: number
  tasks: Array<{ id: string; title: string; taskId?: string; checked: boolean }>
  assets: Array<{ assetId: string; label?: string }>
  body: string
  created: string
  updated: string
  resolvedTasks: Record<string, { column: string; title: string } | null>
  resolvedAssets: ResolvedAsset[]
  brainstormMessages?: ConversationMessage[]
}

type AssetPickerMode = { type: 'attach' } | { type: 'relink'; target: ResolvedAsset }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type StatusTone = 'neutral' | 'success' | 'attention' | 'danger' | 'accent'

const STATUS_CONFIG: Record<ProjectStatus, { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
}

const IMAGE_TYPES = new Set(['images', 'image'])
const VIDEO_TYPES = new Set(['video'])
const AUDIO_TYPES = new Set(['audio'])

const ASSET_ICONS: Record<string, typeof FileText> = {
  text: FileText,
  images: Image,
  video: Film,
  audio: Music,
}

function AssetIcon({ type }: { type: string }) {
  const Icon = ASSET_ICONS[type] || File
  return <Icon className="size-3.5 shrink-0 text-bakin-text-muted" />
}

function AssetThumb({ asset }: { asset: ResolvedAsset }) {
  const [err, setErr] = useState(false)
  if (IMAGE_TYPES.has(asset.type) && !asset.missing && !err) {
    return (
      <img
        src={`/api/assets/${encodeURIComponent(asset.assetId)}`}
        alt={asset.assetId}
        onError={() => setErr(true)}
        className="size-bakin-8 rounded object-cover shrink-0 bg-bakin-surface-elevated"
      />
    )
  }
  return (
    <div className="size-bakin-8 rounded bg-bakin-surface-elevated flex items-center justify-center shrink-0">
      <AssetIcon type={asset.type} />
    </div>
  )
}

function assetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`
}

function assetHref(assetId: string): string {
  return `/assets/${encodeURIComponent(assetId)}`
}

function assetName(asset: ResolvedAsset): string {
  return asset.label || asset.assetId
}

function AssetPreviewModal({ asset, onClose }: { asset: ResolvedAsset; onClose: () => void }) {
  const name = assetName(asset)
  const url = assetUrl(asset.assetId)
  const href = assetHref(asset.assetId)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl" closeLabel="Close preview" data-testid="asset-preview">
        <DialogHeader>
          <DialogTitle className="truncate">{name}</DialogTitle>
          <DialogDescription>{asset.type}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 justify-center">
          {IMAGE_TYPES.has(asset.type) ? (
            <img
              src={url}
              alt={name}
              className="max-w-full rounded object-contain"
            />
          ) : VIDEO_TYPES.has(asset.type) ? (
            <video
              src={url}
              controls
              className="max-w-full rounded bg-bakin-canvas-default"
            />
          ) : AUDIO_TYPES.has(asset.type) ? (
            <audio src={url} controls className="w-full" />
          ) : (
            <div className="flex flex-col items-center gap-bakin-3 text-center">
              <div className="flex size-12 items-center justify-center rounded bg-bakin-surface-elevated">
                <AssetIcon type={asset.type} />
              </div>
              <Text size="meta" tone="muted">No inline preview for this asset type.</Text>
            </div>
          )}
        </div>
        <DialogFooter showCloseButton>
          <PluginLink to={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Open asset</PluginLink>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectDetail({ projectId, onBack, initialEdit = false, onEditChange }: { projectId?: string; onBack: () => void; initialEdit?: boolean; onEditChange?: (editing: boolean) => void }) {
  const router = useRouter()
  const isNew = !projectId
  const currentId = projectId || ''
  const mainAgentId = useMainAgentId() ?? ''
  const [project, setProject] = useState<ProjectData | null>(null)
  const [loading, setLoading] = useState(!isNew)

  // Draggable divider between the main plan column and the progress/tasks sidebar.
  const { width: sidebarWidth, handleProps: sidebarResizeProps } = useHorizontalResize({
    defaultWidth: 346,
    minWidth: 280,
    maxWidth: 640,
    storageKey: 'projects-sidebar',
  })

  // Edit mode — single toggle for title + spec
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editOwner, setEditOwner] = useState('')
  const [editStatus, setEditStatus] = useState<ProjectStatus>('draft')
  const [editBody, setEditBody] = useState('')

  // Brainstorm
  const [brainstormAgent, setBrainstormAgent] = useState(mainAgentId)
  // The focused conversation kit and AgentSelect are presentation-only — the
  // consumer resolves agent identity and supplies the selectable agents.
  const agentList = useAgentList()
  const selectableAgents = useMemo(
    () => agentList.map((agent) => ({
      id: agent.id,
      name: agent.name ?? agent.id,
      imageSrc: agent.headshot ?? null,
    })),
    [agentList],
  )
  const brainstormConversationAgent = useMemo<ConversationAgent | undefined>(() => {
    if (!brainstormAgent) return undefined
    const agent = agentList.find((candidate) => candidate.id === brainstormAgent)
    return {
      id: brainstormAgent,
      name: agent?.name ?? brainstormAgent,
      ...(agent?.headshot ? { avatarUrl: agent.headshot } : {}),
    }
  }, [agentList, brainstormAgent])

  // Plan history "Diff" view (bakin#703)
  const [showChanges, setShowChanges] = useState(false)
  // Change hints on the rendered view — sticky preference.
  const [showChangeHints, setShowChangeHints] = useState(() => {
    try { return localStorage.getItem('projects-show-change-hints') !== 'false' } catch { return true }
  })
  const toggleChangeHints = (next: boolean) => {
    setShowChangeHints(next)
    try { localStorage.setItem('projects-show-change-hints', String(next)) } catch { /* private mode */ }
  }


  // Assets
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [assetPickerMode, setAssetPickerMode] = useState<AssetPickerMode>({ type: 'attach' })
  const [assetSearch, setAssetSearch] = useState('')
  const [assetCollection, setAssetCollection] = useState<AssetPickerCollection>({ status: 'loading' })
  const [previewAsset, setPreviewAsset] = useState<ResolvedAsset | null>(null)
  const [assetRelinkError, setAssetRelinkError] = useState<string | null>(null)
  const [relinkingAsset, setRelinkingAsset] = useState(false)

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteLinkedTasks, setDeleteLinkedTasks] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [assetDetachTarget, setAssetDetachTarget] = useState<ResolvedAsset | null>(null)
  const [detachingAsset, setDetachingAsset] = useState(false)
  const [assetDetachError, setAssetDetachError] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  // Read at refetch time so a brainstorm settling minutes later can't
  // clobber a draft the user is typing (review C1: settle used to wipe
  // unsaved edits and silently exit edit mode).
  const editingRef = useRef(false)
  editingRef.current = editing

  const fetchProject = useCallback(async (enterEdit?: boolean) => {
    if (!currentId) return
    try {
      const res = await fetch(`/api/plugins/projects/${currentId}`)
      if (res.ok) {
        const data = await res.json()
        setProject(data.project)
        if (editingRef.current && enterEdit === undefined) {
          // Mid-edit background refresh: update the server copy only —
          // never the draft fields or the mode.
          return
        }
        setEditTitle(data.project.title)
        setEditOwner(data.project.owner)
        setEditStatus(data.project.status)
        setEditBody(data.project.body)
        const shouldEdit = enterEdit ?? false
        setEditing(shouldEdit)
        onEditChange?.(shouldEdit)
      }
    } finally {
      setLoading(false)
    }
  }, [currentId, onEditChange])

  useEffect(() => {
    if (isNew) {
      router.replace('/projects')
    } else {
      fetchProject(initialEdit)
    }
  }, [])

  // Sync default owner once main agent id resolves from the team store.
  useEffect(() => {
    if (!mainAgentId) return
    setBrainstormAgent((prev) => (prev ? prev : mainAgentId))
    if (isNew) {
      setEditOwner((prev) => (prev ? prev : mainAgentId))
      setProject((prev) => (prev && !prev.owner ? { ...prev, owner: mainAgentId } : prev))
    }
  }, [mainAgentId, isNew])

  // ---------------------------------------------------------------------------
  // Dirty state — anything changed from server state
  // ---------------------------------------------------------------------------

  const isDirty = project && (
      editTitle !== project.title ||
      editOwner !== project.owner ||
      editStatus !== project.status ||
      editBody !== project.body
    )

  // ---------------------------------------------------------------------------
  // Edit mode actions
  // ---------------------------------------------------------------------------

  const saveField = async (field: string, value: string) => {
    if (isNew || !currentId) return
    await fetch(`/api/plugins/projects/${currentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    fetchProject()
  }

  const enterEdit = () => {
    if (!project) return
    setEditTitle(project.title)
    setEditBody(project.body)
    setEditing(true)
    onEditChange?.(true)
  }

  const cancelEdit = () => {
    if (!project) return
    setEditTitle(project.title)
    setEditBody(project.body)
    setEditing(false)
    onEditChange?.(false)
  }

  const handleSave = async () => {
    if (!project || !isDirty || !currentId) return

    const updates: Record<string, string> = { id: currentId }
    if (editTitle !== project.title) updates.title = editTitle
    if (editOwner !== project.owner) updates.owner = editOwner
    if (editStatus !== project.status) updates.status = editStatus
    if (editBody !== project.body) updates.body = editBody
    await fetch(`/api/plugins/projects/${currentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    fetchProject()
  }

  // ---------------------------------------------------------------------------
  // Checklist handlers
  // ---------------------------------------------------------------------------

  const toggleItem = async (taskItemId: string, checked: boolean) => {
    if (!currentId) return
    await fetch(`/api/plugins/projects/${currentId}/checklist/${taskItemId}/toggle`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked }) })
    fetchProject()
  }
  const addItem = async (title: string) => {
    if (!currentId) return
    await fetch(`/api/plugins/projects/${currentId}/checklist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) })
    fetchProject()
  }
  const removeItem = async (taskItemId: string) => {
    if (!currentId) return
    await fetch(`/api/plugins/projects/${currentId}/checklist/${taskItemId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
    fetchProject()
  }
  const promoteItem = async (taskItemId: string) => {
    if (!currentId) return
    await fetch(`/api/plugins/projects/${currentId}/checklist/${taskItemId}/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    fetchProject()
  }

  // ---------------------------------------------------------------------------
  // Brainstorm
  // ---------------------------------------------------------------------------

  // The server owns the transcript AND the turn (bakin#703): the ask route
  // 202s and the turn streams as projects.brainstorm.* bus events, so
  // navigating away never kills it and remounting rehydrates mid-stream
  // (server-seeded `brainstormStreaming`). The kit hook adds the
  // synchronous optimistic user echo.
  const brainstormAgentRef = useRef(brainstormAgent)
  brainstormAgentRef.current = brainstormAgent
  // Bridged via ref: markBrainstormSeen is defined below (it needs state
  // declared after this hook), while onSettled here needs to call it.
  const markBrainstormSeenRef = useRef<() => void>(() => {})
  const brainstorm = useConversationThread({
    threadKey: currentId ?? '',
    events: {
      chunk: 'projects.brainstorm.chunk',
      done: 'projects.brainstorm.done',
      error: 'projects.brainstorm.error',
    },
    keyOf: useCallback((payload: Record<string, unknown>) => payload.projectId, []),
    load: useCallback(async (key: string) => {
      const res = await fetch(`/api/plugins/projects/${key}`)
      if (!res.ok) return null
      const data = await res.json()
      return {
        messages: Array.isArray(data.project?.brainstormMessages) ? data.project.brainstormMessages : [],
        streaming: data.project?.brainstormStreaming === true,
        ...(typeof data.project?.brainstormStreamingText === 'string' ? { streamingText: data.project.brainstormStreamingText } : {}),
      }
    }, []),
    post: useCallback(async (key: string, content: string) => {
      const res = await fetch(`/api/plugins/projects/${key}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: key, prompt: content, agent: brainstormAgentRef.current }),
      })
      if (res.ok) return { ok: true }
      const body = await res.json().catch(() => ({}))
      return { ok: false, status: res.status, ...(body.error ? { error: String(body.error) } : {}) }
    }, []),
    // Refresh after a reply settles — the agent may have updated the spec —
    // and the reply landed while the user was looking at this project.
    onSettled: useCallback(() => {
      fetchProject()
      markBrainstormSeenRef.current()
    }, [fetchProject]),
  })

  // Send failures (409 busy, network) surface as a toast; the optimistic
  // row stays visible in the panel.
  useEffect(() => {
    if (brainstorm.sendError) toast(brainstorm.sendError, 'error')
  }, [brainstorm.sendError])

  // The agent edits the plan MID-turn (apply_plan tool calls) — refresh the
  // visible plan when tool activity lands instead of waiting for settle
  // (review I1: "Applied a project plan" rows next to an unchanged plan).
  usePluginEvent('projects.brainstorm.chunk', (payload) => {
    if (payload.projectId !== currentId) return
    const chunk = payload.chunk as { type?: string } | undefined
    if (chunk?.type === 'tool') void fetchProject()
  })

  // Viewing the project (or a reply landing while viewing) marks the
  // brainstorm seen; the synthetic bus event refreshes the nav badge only
  // AFTER the write lands (the chat pattern — refreshing on done alone
  // races the seen POST). Hidden/background tabs never mark seen — nobody
  // saw anything.
  const markBrainstormSeen = useCallback(() => {
    if (!currentId || isNew || document.visibilityState !== 'visible') return
    void fetch(`/api/plugins/projects/${currentId}/brainstorm/seen`, { method: 'POST' })
      .then(() => emitPluginEvent({ event: 'projects.brainstorm.seen', projectId: currentId }))
      .catch(() => {})
  }, [currentId, isNew])

  markBrainstormSeenRef.current = markBrainstormSeen

  useEffect(() => {
    markBrainstormSeen()
  }, [markBrainstormSeen])

  const abortBrainstorm = useCallback(() => {
    if (!currentId) return
    void fetch(`/api/plugins/projects/${currentId}/ask/abort`, { method: 'POST' }).catch(() => {})
  }, [currentId])

  // "Try again" on an error turn re-sends the newest user message (chat parity).
  const retryBrainstorm = useCallback(() => {
    const lastUser = [...brainstorm.messages].reverse().find((m) => m.kind === 'user')
    if (lastUser?.kind === 'user' && lastUser.content) void brainstorm.send(lastUser.content)
  }, [brainstorm])

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  // Load the pickable asset library for the SDK AssetPicker: the plugin owns
  // the data (assets-plugin REST fetch + attached-filter), the pattern owns
  // the presentation. Loading/error land as honest collection states.
  const loadAssetCollection = useCallback(async (mode: AssetPickerMode) => {
    setAssetCollection({ status: 'loading' })
    try {
      const res = await fetch('/api/plugins/assets/versioned')
      if (!res.ok) throw new Error(`Asset library returned ${res.status}`)
      const data = await res.json()
      const attached = new Set(
        (project?.assets || [])
          .filter(a => mode.type !== 'relink' || a.assetId !== mode.target.assetId)
          .map(a => a.assetId)
      )
      setAssetCollection({
        status: 'ready',
        assets: (data.assets || [])
          .filter((a: { assetId: string }) => !attached.has(a.assetId))
          .map((a: { assetId: string; type: string; description?: string }) => ({
            id: a.assetId,
            label: a.assetId,
            description: a.description,
            type: a.type,
            thumbnailSrc: IMAGE_TYPES.has(a.type) ? assetUrl(a.assetId) : undefined,
          })),
      })
    } catch {
      // assets plugin may not be available
      setAssetCollection({ status: 'error', message: 'The asset library is unavailable right now.' })
    }
  }, [project])

  const openAssetPicker = (mode: AssetPickerMode) => {
    setAssetPickerMode(mode)
    setAssetRelinkError(null)
    setAssetSearch('')
    setAssetPickerOpen(true)
    void loadAssetCollection(mode)
  }

  const handleAttachAsset = async (assetId: string) => {
    if (!currentId) return
    await fetch(`/api/plugins/projects/${currentId}/assets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId }) })
    setAssetPickerOpen(false)
    fetchProject()
  }

  const handleRelinkAsset = async (target: ResolvedAsset, newAssetId: string) => {
    if (!currentId || relinkingAsset) return
    setRelinkingAsset(true)
    setAssetRelinkError(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    try {
      const res = await fetch(`/api/plugins/projects/${currentId}/assets/${encodeURIComponent(target.assetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentId, assetId: target.assetId, newAssetId }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const message = await res.text().catch(() => '')
        throw new Error(message || `Relink failed with status ${res.status}`)
      }
      setAssetPickerOpen(false)
      void fetchProject()
    } catch (err) {
      const message = err instanceof DOMException && err.name === 'AbortError'
        ? 'Relink timed out. Check the server log and try again.'
        : err instanceof Error
          ? err.message
          : 'Failed to relink asset.'
      setAssetRelinkError(message)
    } finally {
      window.clearTimeout(timeout)
      setRelinkingAsset(false)
    }
  }

  const handlePickerAssetSelect = async (assetId: string) => {
    if (assetPickerMode.type === 'relink') {
      await handleRelinkAsset(assetPickerMode.target, assetId)
      return
    }
    await handleAttachAsset(assetId)
  }

  const handleDetachAsset = async (assetId: string) => {
    if (!currentId) return
    setDetachingAsset(true)
    setAssetDetachError(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    try {
      const res = await fetch(`/api/plugins/projects/${currentId}/assets/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentId, assetId }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const message = await res.text().catch(() => '')
        throw new Error(message || `Detach failed with status ${res.status}`)
      }
      setAssetDetachTarget(null)
      void fetchProject()
    } catch (err) {
      const message = err instanceof DOMException && err.name === 'AbortError'
        ? 'Detach timed out. Check the server log and try again.'
        : err instanceof Error
          ? err.message
          : 'Failed to detach asset.'
      setAssetDetachError(message)
    } finally {
      window.clearTimeout(timeout)
      setDetachingAsset(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  const linkedTaskCount = project?.tasks.filter(t => t.taskId).length ?? 0

  const handleDelete = async (deleteLinkedTasks: boolean) => {
    if (!currentId) return
    setDeleting(true)
    try {
      await fetch(`/api/plugins/projects/${currentId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteLinkedTasks }),
      })
      onBack()
    } finally {
      setDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <Page>
        <SystemState
          kind="loading"
          scope="section"
          title="Loading project"
          description="Project details will appear here."
          preview={(
            <div className="flex flex-col gap-bakin-3">
              <Skeleton className="h-bakin-6 w-60" />
              <Skeleton className="h-bakin-4 w-40" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
        />
      </Page>
    )
  }
  if (!project) {
    return (
      <Page>
        <SystemState
          kind="error"
          recovery="unavailable"
          scope="section"
          title="Project not found"
          description="This project may have been deleted or its file moved."
        />
      </Page>
    )
  }

  const statusCfg = STATUS_CONFIG[editStatus]

  return (
    <Page scroll="contained">
    <div data-slot="project-detail" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">

      {/* ── Header ── */}
      <PageHeader
        className="shrink-0"
        measure="wide"
        navigation={(
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to projects">
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        eyebrow="Projects / detail"
        title={(editing ? editTitle : project.title) || 'Untitled project'}
        actions={(
          <div className="flex w-full min-w-0 flex-wrap items-center gap-bakin-2 @3xl/page-header:w-auto">
            {/* Status */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={(
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Project status"
                  />
                )}
              >
                <StatusMarker tone={statusCfg.tone} size="sm" />
                {statusCfg.label}
                <ChevronDown className="size-bakin-3 text-bakin-text-muted" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(Object.entries(STATUS_CONFIG) as [ProjectStatus, typeof statusCfg][]).map(([val, cfg]) => (
                  <DropdownMenuItem
                    key={val}
                    onClick={() => { setEditStatus(val); if (!editing) saveField('status', val) }}
                  >
                    <StatusMarker tone={cfg.tone} size="sm" />
                    {cfg.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Owner */}
            <AgentSelect
              value={editOwner}
              onValueChange={(v) => { setEditOwner(v); if (!editing) saveField('owner', v) }}
              agents={selectableAgents}
              ariaLabel="Project owner"
              className="h-bakin-8 min-w-0 flex-1 bg-bakin-surface-default text-sm @3xl/page-header:min-w-36 @3xl/page-header:flex-none"
            />

            {/* Edit / Save / Cancel */}
            {editing ? (
              <>
                <Button variant="ghost" size="sm" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!isDirty}>
                  Save
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={enterEdit}>
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            )}
          </div>
        )}
        overflowActionsLabel="Project actions"
        overflowActions={(
          <DropdownMenuItem variant="danger" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        )}
      />

      {/* ── Delete confirmation dialog ── */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete project?"
        description={(
          <>This will permanently delete <Text weight="medium">{project.title}</Text> and all its checklist items.</>
        )}
        confirmLabel="Delete"
        busyLabel="Deleting..."
        confirmTone="danger"
        busy={deleting}
        onConfirm={() => handleDelete(linkedTaskCount > 0 && deleteLinkedTasks)}
        onCancel={() => {
          if (deleting) return
          setDeleteDialogOpen(false)
          setDeleteLinkedTasks(false)
        }}
      >
        {linkedTaskCount > 0 && (
          <div className="flex flex-col gap-bakin-2">
            <Text as="p" size="meta" tone="muted">
              This project has <Text size="meta" weight="medium">{linkedTaskCount}</Text> linked board {linkedTaskCount === 1 ? 'task' : 'tasks'}. Unchecked, {linkedTaskCount === 1 ? 'it stays' : 'they stay'} on the board.
            </Text>
            <Field orientation="horizontal" name="deleteLinkedTasks">
              <Checkbox
                checked={deleteLinkedTasks}
                onCheckedChange={(checked: boolean) => setDeleteLinkedTasks(checked === true)}
              />
              <FieldLabel>Also delete {linkedTaskCount === 1 ? 'the linked board task' : 'the linked board tasks'}</FieldLabel>
            </Field>
          </div>
        )}
      </ConfirmDialog>

      {/* ── Asset detach confirmation dialog ── */}
      <ConfirmDialog
        open={Boolean(assetDetachTarget)}
        title="Detach asset?"
        description={assetDetachTarget ? (
          <>This removes <Text weight="medium">{assetName(assetDetachTarget)}</Text> from this project. It will not delete the asset file.</>
        ) : undefined}
        confirmLabel="Detach"
        busyLabel="Detaching..."
        confirmTone="danger"
        busy={detachingAsset}
        error={assetDetachError}
        onConfirm={() => { if (assetDetachTarget) void handleDetachAsset(assetDetachTarget.assetId) }}
        onCancel={() => {
          if (detachingAsset) return
          setAssetDetachTarget(null)
        }}
      >
        {assetDetachTarget?.missing && (
          <Alert tone="attention">
            <AlertDescription>
              Bakin can't find this asset. Detaching it cleans up the broken project reference.
            </AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>

      {/* ── Two-column body ── */}
      <div
        data-slot="project-detail-body"
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-bakin-6 overflow-y-auto pt-bakin-6 lg:flex-row lg:overflow-hidden"
      >

        {/* ── Main column ── */}
        <div className="flex w-full min-w-0 shrink-0 flex-col lg:min-h-0 lg:flex-1">

          {/* Scrollable content area */}
          <div className="min-w-0 shrink-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-bakin-1">
            {/* Title (edit mode only — the page title lives in PageHeader) */}
            {editing ? (
              <Field name="title" className="mb-bakin-6">
                <FieldLabel>Title</FieldLabel>
                <Input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="!h-auto w-full rounded-bakin-control px-bakin-4 py-2.5 text-xl font-bakin-typography-weight-semibold tracking-tight md:text-xl"
                  placeholder="Untitled project"
                  aria-label="Project title"
                  autoFocus
                />
              </Field>
            ) : null}

            {/* Details (spec) — the header row stays pinned while the plan
                scrolls; Rendered|Diff rides the SDK SegmentedControl. */}
            <div className="sticky top-0 z-10 -mx-bakin-1 flex items-center justify-between bg-bakin-surface-default px-bakin-1 pt-bakin-1 pb-bakin-2">
              <h3>Details</h3>
              {!editing && (
                <div className="flex items-center gap-bakin-3">
                  {!showChanges && (
                    <Field orientation="horizontal" name="showChangeHints" data-testid="show-changes-switch">
                      <Switch size="sm" checked={showChangeHints} onCheckedChange={toggleChangeHints} />
                      <FieldLabel>Show changes</FieldLabel>
                    </Field>
                  )}
                  <SegmentedControl
                    options={[{ value: 'details', label: 'Rendered' }, { value: 'changes', label: 'Diff' }]}
                    value={showChanges ? 'changes' : 'details'}
                    onValueChange={(value: string) => setShowChanges(value === 'changes')}
                    ariaLabel="Plan view"
                  />
                </div>
              )}
            </div>
            <div className="mb-bakin-6">
              {showChanges && !editing ? (
                <PlanHistoryPanel
                  projectId={currentId ?? ''}
                  currentBody={project.body}
                  onRestored={() => fetchProject()}
                />
              ) : editing ? (
                <ProjectEditor
                  body={editBody}
                  editing={editing}
                  onChange={setEditBody}
                />
              ) : (
                <RenderedPlan projectId={currentId ?? ''} body={project.body} hintsEnabled={showChangeHints} />
              )}
            </div>

          </div>

          {/* ── Brainstorm — pinned at bottom ── */}
          <ConversationPanel
            messages={brainstorm.messages}
            liveChunks={brainstorm.liveChunks}
            streaming={brainstorm.streaming}
            onSend={brainstorm.send}
            onAbort={abortBrainstorm}
            onRetry={retryBrainstorm}
            agent={brainstormConversationAgent}
            agentControl={(
              <AgentSelect
                value={brainstormAgent}
                onValueChange={setBrainstormAgent}
                agents={selectableAgents}
                ariaLabel="Brainstorm agent"
                className="h-bakin-8"
              />
            )}
            storageKey={`project:${currentId}`}
            showHeader={false}
            chrome="top-divider"
            autoFocus={false}
            placeholder="Ask about this project..."
            emptyState={(
              <ConversationEmptyState
                title="Brainstorm this project with an agent"
                description={'The agent treats the plan above as its working document — it applies small edits directly (every change is snapshotted, see the Diff view) and asks before big rewrites. Try "flesh out the plan", "what\'s missing?", or "break this into tasks".'}
              />
            )}
          />
        </div>

        {/* ── Right sidebar (resizable) ── */}
        <div
          className="relative w-full shrink-0 space-y-5 border-t border-bakin-border-subtle pt-bakin-6 lg:w-[var(--project-sidebar-width)] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:pl-bakin-6 lg:pr-bakin-2 lg:pt-0"
          style={{ '--project-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          {/* Drag handle — sits over the left border to resize the sidebar.
              role / aria-orientation / tabIndex / aria-value* / keyboard all come from handleProps. */}
          <div
            {...sidebarResizeProps}
            aria-label="Resize progress panel"
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-bakin-signal-accent/50 active:bg-bakin-signal-accent lg:block"
          />

          {/* Progress */}
          <div>
            <div className="mb-bakin-2 flex items-center justify-between">
              <h3>Progress</h3>
              <Text size="meta" tone="muted" mono className="tabular-nums">{project.progress}%</Text>
            </div>
            <Progress value={project.progress} aria-label="Project progress" />
          </div>

          <Separator />

          {/* Checklist */}
          <ProjectChecklist
            projectId={currentId}
            tasks={project.tasks}
            resolvedTasks={project.resolvedTasks}
            onToggle={toggleItem}
            onAdd={addItem}
            onRemove={removeItem}
            onPromote={promoteItem}
          />

          <Separator />

          {/* Assets */}
          <div>
            <div className="mb-bakin-3 flex items-center justify-between">
              <h3>Assets</h3>

              <Button
                variant="ghost"
                size="xs"
                onClick={() => openAssetPicker({ type: 'attach' })}
                className="gap-bakin-1 font-bakin-typography-weight-regular text-bakin-text-muted hover:bg-transparent hover:text-bakin-text-primary"
              >
                <Paperclip className="size-bakin-3" />
                Attach
              </Button>
            </div>

            {project.resolvedAssets.length === 0 ? (
              <SystemState kind="initial-empty" scope="inline" headingLevel={4} title="No assets attached." />
            ) : (
              <div className="flex flex-col gap-bakin-2">
                {project.resolvedAssets.some(asset => asset.missing) && (
                  <Alert tone="attention">
                    <AlertDescription>
                      Some attached assets could not be loaded. Detach broken references to clean up this project.
                    </AlertDescription>
                  </Alert>
                )}
                <ListRows variant="separated" size="sm" aria-label="Attached assets">
                  {project.resolvedAssets.map((asset) => (
                    <ListRow
                      key={asset.assetId}
                      className="flex items-start gap-bakin-2"
                      interactive={asset.missing ? undefined : { label: `Open ${assetName(asset)}`, onActivate: () => setPreviewAsset(asset) }}
                    >
                      <AssetThumb asset={asset} />
                      <div className="min-w-0 flex-1">
                        <Text as="p" size="meta" className="truncate leading-tight">{assetName(asset)}</Text>
                        {asset.description && (
                          <Text as="p" size="meta" tone="muted" className="truncate">{asset.description}</Text>
                        )}
                        {asset.tags && asset.tags.length > 0 && (
                          <div className="mt-bakin-1 flex flex-wrap gap-bakin-1">
                            {asset.tags.slice(0, 3).map(tag => (
                              <Badge key={tag} size="xs" tone="neutral" variant="soft">{tag}</Badge>
                            ))}
                          </div>
                        )}
                        {asset.missing && (
                          <StatusBadge tone="attention" variant="soft" size="xs" className="mt-bakin-1">can't find asset</StatusBadge>
                        )}
                      </div>
                      {/* Missing assets keep their repair actions visible; healthy rows reveal on hover / focus-within. */}
                      <ListRowActions reveal={asset.missing ? 'always' : 'hover'}>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => openAssetPicker({ type: 'relink', target: asset })}
                          aria-label={`Relink ${assetName(asset)}`}
                        >
                          <Link2 aria-hidden="true" />
                          Relink
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => { setAssetDetachError(null); setAssetDetachTarget(asset) }}
                          aria-label={`Detach ${assetName(asset)}`}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </ListRowActions>
                    </ListRow>
                  ))}
                </ListRows>
              </div>
            )}

          </div>

          <Separator />

          {/* Meta */}
          <div>
            <h3 className="mb-bakin-2">Details</h3>
            <KeyValue
              layout="rows"
              items={[
                { label: 'Created', value: formatDateTime(project.created) },
                { label: 'Updated', value: formatAge(project.updated) },
                { label: 'ID', value: project.id.slice(0, 8), mono: true },
              ]}
            />
          </div>
        </div>

      </div>

      {/* ── Asset picker (SDK pattern; plugin owns the collection data) ── */}
      <AssetPicker
        open={assetPickerOpen}
        onOpenChange={(open) => {
          if (!open && relinkingAsset) return
          setAssetPickerOpen(open)
        }}
        collection={assetCollection}
        query={assetSearch}
        onQueryChange={setAssetSearch}
        onPick={(assetId) => { void handlePickerAssetSelect(assetId) }}
        onRetry={() => { void loadAssetCollection(assetPickerMode) }}
        busy={relinkingAsset}
        notice={assetRelinkError}
        view="list"
        title={assetPickerMode.type === 'relink' ? 'Relink asset' : 'Attach asset'}
        description={assetPickerMode.type === 'relink'
          ? `Choose a replacement for ${assetName(assetPickerMode.target)}.`
          : 'Choose an asset from the library to attach to this project.'}
        emptyTitle="No assets available"
        emptyDescription="Add an asset to the library, then return here to choose it."
      />

      {previewAsset && <AssetPreviewModal asset={previewAsset} onClose={() => setPreviewAsset(null)} />}
    </div>
    </Page>
  )
}
