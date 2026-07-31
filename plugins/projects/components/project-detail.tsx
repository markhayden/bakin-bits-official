'use client'

import { useState, useCallback, useMemo, useRef, useEffect, type CSSProperties } from 'react'
import { useHorizontalResize } from '@makinbakin/sdk/hooks'
import { ArrowLeft, Paperclip, X, FileText, Image, Film, Music, File, ChevronDown, Pencil, Trash2, Link2 } from 'lucide-react'
import { useAgentList, useMainAgentId } from "@makinbakin/sdk/hooks"
import { useRouter } from "@makinbakin/sdk/navigation"
import { ConversationEmptyState, ConversationPanel } from "@makinbakin/sdk/conversation"
import type { ConversationAgent, ConversationMessage } from "@makinbakin/sdk/conversation"
import { AgentSelect, AssetPicker, Page, PageHeaderOverflowMenu } from "@makinbakin/sdk/patterns"
import type { AssetPickerCollection } from "@makinbakin/sdk/patterns"
import { ProjectChecklist } from './project-checklist'
import { ProjectEditor } from './project-editor'
import { DropdownMenuItem, Progress, Skeleton, SystemState } from "@makinbakin/sdk/ui"
import type { ProjectStatus } from '../types'
import { useConversationStream } from '../hooks/use-conversation-stream'

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
  updated: string
  resolvedTasks: Record<string, { column: string; title: string } | null>
  resolvedAssets: ResolvedAsset[]
  brainstormMessages?: ConversationMessage[]
}

type AssetPickerMode = { type: 'attach' } | { type: 'relink'; target: ResolvedAsset }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<ProjectStatus, { label: string; dot: string }> = {
  draft: { label: 'Draft', dot: 'bg-zinc-400' },
  active: { label: 'Active', dot: 'bg-[#5e6ad2]' },
  completed: { label: 'Completed', dot: 'bg-emerald-400' },
  archived: { label: 'Archived', dot: 'bg-zinc-600' },
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
  return <Icon className="size-3.5 shrink-0 text-zinc-500" />
}

function AssetThumb({ asset }: { asset: ResolvedAsset }) {
  const [err, setErr] = useState(false)
  if (IMAGE_TYPES.has(asset.type) && !asset.missing && !err) {
    return (
      <img
        src={`/api/assets/${encodeURIComponent(asset.assetId)}`}
        alt={asset.assetId}
        onError={() => setErr(true)}
        className="size-8 rounded object-cover shrink-0 bg-zinc-800"
      />
    )
  }
  return (
    <div className="size-8 rounded bg-zinc-800/60 flex items-center justify-center shrink-0">
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-8"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] max-w-[90vw] flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {IMAGE_TYPES.has(asset.type) ? (
          <img
            src={url}
            alt={name}
            className="max-h-[80vh] max-w-[90vw] rounded object-contain"
          />
        ) : VIDEO_TYPES.has(asset.type) ? (
          <video
            src={url}
            controls
            className="max-h-[80vh] max-w-[90vw] rounded bg-black"
          />
        ) : AUDIO_TYPES.has(asset.type) ? (
          <div className="w-[min(90vw,520px)] rounded-lg border border-[rgba(255,255,255,0.10)] bg-zinc-950 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm text-zinc-200">
              <AssetIcon type={asset.type} />
              <span className="truncate">{name}</span>
            </div>
            <audio src={url} controls className="w-full" />
          </div>
        ) : (
          <div className="flex w-[min(90vw,420px)] flex-col items-center gap-3 rounded-lg border border-[rgba(255,255,255,0.10)] bg-zinc-950 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded bg-zinc-900">
              <AssetIcon type={asset.type} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-200">{name}</p>
              <p className="mt-1 text-xs text-zinc-500">{asset.type}</p>
            </div>
          </div>
        )}
        <div className="flex items-center gap-4 text-sm text-zinc-300">
          <a href={href} className="underline hover:text-white">Open asset</a>
          <button type="button" onClick={onClose} className="flex items-center gap-1 hover:text-white">
            <X className="size-4" /> Close
          </button>
        </div>
      </div>
    </div>
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
  const [brainstormMessages, setBrainstormMessages] = useState<ConversationMessage[]>([])
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

  // Dropdowns
  const [statusOpen, setStatusOpen] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)

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
  const [deleting, setDeleting] = useState(false)
  const [assetDetachTarget, setAssetDetachTarget] = useState<ResolvedAsset | null>(null)
  const [detachingAsset, setDetachingAsset] = useState(false)
  const [assetDetachError, setAssetDetachError] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchProject = useCallback(async (enterEdit?: boolean) => {
    if (!currentId) return
    try {
      const res = await fetch(`/api/plugins/projects/${currentId}`)
      if (res.ok) {
        const data = await res.json()
        setProject(data.project)
        setEditTitle(data.project.title)
        setEditOwner(data.project.owner)
        setEditStatus(data.project.status)
        setEditBody(data.project.body)
        setBrainstormMessages(Array.isArray(data.project.brainstormMessages) ? data.project.brainstormMessages : [])
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

  // Close status dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

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

  // The server owns the transcript (ConversationMessage rows in the
  // project payload); the compatibility transport drives the live turn over the
  // `chunk` SSE frames the ask route emits.
  const brainstorm = useConversationStream({
    fetcher: useCallback(
      (content: string, ctx: { signal: AbortSignal }) => {
        if (!currentId) throw new Error('Create the project before starting a brainstorm.')
        return fetch(`/api/plugins/projects/${currentId}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({ projectId: currentId, prompt: content, agent: brainstormAgent }),
        })
      },
      [currentId, brainstormAgent],
    ),
    // Refresh after a reply lands — the agent may have updated the spec,
    // and the durable transcript replaces the live chunks.
    onDone: () => fetchProject(),
    onError: () => fetchProject(),
  })

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
              <Skeleton className="h-6 w-60" />
              <Skeleton className="h-4 w-40" />
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

      {/* ── Top bar ── */}
      <div
        data-slot="project-detail-toolbar"
        className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-bakin-3 border-b border-bakin-border-subtle pb-bakin-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
      >
        <button
          onClick={onBack}
          className="flex shrink-0 items-center gap-bakin-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Projects
        </button>

        <div className="col-span-2 row-start-2 flex min-w-0 flex-col gap-bakin-2 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          <div className="flex min-w-0 items-center gap-bakin-2">
            {/* Status */}
            <div ref={statusRef} className="relative shrink-0">
              <button
                onClick={() => setStatusOpen(!statusOpen)}
                className="inline-flex h-bakin-8 items-center gap-1.5 rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default px-bakin-3 text-sm font-medium text-bakin-text-primary transition-colors hover:bg-bakin-surface-elevated"
              >
                <span className={`size-1.5 rounded-full ${statusCfg.dot}`} />
                {statusCfg.label}
                <ChevronDown className="size-3 text-zinc-500" />
              </button>
              {statusOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 w-36 rounded-lg border border-[rgba(255,255,255,0.08)] bg-zinc-900 py-1 shadow-xl sm:left-auto sm:right-0">
                  {(Object.entries(STATUS_CONFIG) as [ProjectStatus, typeof statusCfg][]).map(([val, cfg]) => (
                    <button
                      key={val}
                      onClick={() => { setEditStatus(val); setStatusOpen(false); if (!editing) saveField('status', val) }}
                      className={`w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-2 transition-colors ${
                        val === editStatus ? 'text-foreground bg-zinc-800/60' : 'text-zinc-400 hover:text-foreground hover:bg-zinc-800/40'
                      }`}
                    >
                      <span className={`size-1.5 rounded-full ${cfg.dot}`} />
                      {cfg.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Owner */}
            <AgentSelect
              value={editOwner}
              onValueChange={(v) => { setEditOwner(v); if (!editing) saveField('owner', v) }}
              agents={selectableAgents}
              ariaLabel="Project owner"
              className="h-bakin-8 min-w-0 flex-1 bg-bakin-surface-default text-sm sm:w-auto sm:min-w-[9rem] sm:flex-none"
            />
          </div>

          <div className="flex shrink-0 items-center gap-bakin-2">
            {/* Edit / Save / Cancel */}
            {editing ? (
              <>
                <button
                  onClick={cancelEdit}
                  className="h-bakin-8 rounded-bakin-control px-bakin-3 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!isDirty}
                  className={`h-bakin-8 rounded-bakin-control px-bakin-3 text-sm font-medium transition-all ${
                    isDirty
                      ? 'bg-[#5e6ad2] text-white hover:bg-[#6e7ae2] shadow-sm shadow-[#5e6ad2]/20'
                      : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  }`}
                >
                  Save
                </button>
              </>
            ) : (
              <button
                onClick={enterEdit}
                className="inline-flex h-bakin-8 items-center gap-bakin-2 rounded-bakin-control border border-bakin-border-subtle bg-bakin-surface-default px-bakin-3 text-sm text-bakin-text-muted transition-colors hover:bg-bakin-surface-elevated hover:text-bakin-text-primary"
              >
                <Pencil className="size-4" />
                Edit
              </button>
            )}

          </div>
        </div>

        <PageHeaderOverflowMenu label="Project actions">
          <DropdownMenuItem variant="danger" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </PageHeaderOverflowMenu>
      </div>

      {/* ── Delete confirmation dialog ── */}
      {deleteDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => !deleting && setDeleteDialogOpen(false)} />
          <div className="relative bg-zinc-900 border border-[rgba(255,255,255,0.08)] rounded-xl shadow-2xl w-[420px] p-6">
            <h3 className="text-sm font-semibold text-foreground mb-2">Delete project?</h3>
            <p className="text-[12px] text-zinc-400 mb-4">
              This will permanently delete <span className="text-zinc-200 font-medium">{project.title}</span> and all its checklist items.
            </p>

            {linkedTaskCount > 0 && (
              <div className="mb-4 p-3 rounded-lg bg-zinc-800/60 border border-[rgba(255,255,255,0.06)]">
                <p className="text-[11px] text-zinc-300 mb-2">
                  This project has <span className="font-medium text-foreground">{linkedTaskCount}</span> linked board {linkedTaskCount === 1 ? 'task' : 'tasks'}. What should happen to {linkedTaskCount === 1 ? 'it' : 'them'}?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDelete(false)}
                    disabled={deleting}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-700/60 text-zinc-300 hover:text-foreground hover:bg-zinc-700 border border-[rgba(255,255,255,0.06)] transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Keep tasks on board'}
                  </button>
                  <button
                    onClick={() => handleDelete(true)}
                    disabled={deleting}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Delete tasks too'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              {linkedTaskCount === 0 && (
                <button
                  onClick={() => handleDelete(false)}
                  disabled={deleting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Asset detach confirmation dialog ── */}
      {assetDetachTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => !detachingAsset && setAssetDetachTarget(null)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="detach-asset-title"
            className="relative bg-zinc-900 border border-[rgba(255,255,255,0.08)] rounded-xl shadow-2xl w-[420px] p-6"
          >
            <h3 id="detach-asset-title" className="text-sm font-semibold text-foreground mb-2">Detach asset?</h3>
            <p className="text-[12px] text-zinc-400 mb-4">
              This removes <span className="text-zinc-200 font-medium">{assetName(assetDetachTarget)}</span> from this project. It will not delete the asset file.
            </p>
            {assetDetachTarget.missing && (
              <p className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-snug text-amber-200/80">
                Bakin can't find this asset. Detaching it cleans up the broken project reference.
              </p>
            )}
            {assetDetachError && (
              <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] leading-snug text-red-300">
                {assetDetachError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAssetDetachTarget(null)}
                disabled={detachingAsset}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDetachAsset(assetDetachTarget.assetId)}
                disabled={detachingAsset}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors disabled:opacity-50"
              >
                {detachingAsset ? 'Detaching...' : 'Detach'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Two-column body ── */}
      <div
        data-slot="project-detail-body"
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-bakin-6 overflow-y-auto pt-bakin-6 lg:flex-row lg:overflow-hidden"
      >

        {/* ── Main column ── */}
        <div className="flex w-full min-w-0 shrink-0 flex-col lg:min-h-0 lg:flex-1">

          {/* Scrollable content area */}
          <div className="min-w-0 shrink-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-bakin-1">
            {/* Title */}
            <label className="text-[10px] font-medium text-zinc-600 uppercase tracking-wider mb-1.5 block">Title</label>
            {editing ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full text-xl font-semibold text-foreground bg-zinc-900/40 border border-[rgba(255,255,255,0.06)] rounded-lg outline-none px-4 py-2.5 placeholder:text-zinc-500 mb-5 tracking-tight focus:border-[#5e6ad2]/40 transition-colors"
                placeholder="Untitled project"
                autoFocus
              />
            ) : (
              <h1 className="text-xl font-semibold text-foreground tracking-tight mb-5">
                {project.title || 'Untitled project'}
              </h1>
            )}

            {/* Details (spec) */}
            <label className="text-[10px] font-medium text-zinc-600 uppercase tracking-wider mb-1.5 block">Details</label>
            <div className="mb-6">
              <ProjectEditor
                body={editBody}
                editing={editing}
                onChange={setEditBody}
              />
            </div>

          </div>

          {/* ── Brainstorm — pinned at bottom ── */}
          <ConversationPanel
            messages={brainstormMessages}
            liveChunks={brainstorm.liveChunks}
            streaming={brainstorm.streaming}
            onSend={brainstorm.send}
            onAbort={brainstorm.abort}
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
                title="No project conversation yet"
                description="Ask a question about this project to start the conversation."
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
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-accent/50 active:bg-accent lg:block"
          />

          {/* Progress */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Progress</h3>
              <span className="text-[11px] font-mono text-zinc-400 tabular-nums">{project.progress}%</span>
            </div>
            <Progress value={project.progress} aria-label="Project progress" />
          </div>

          {/* Checklist */}
          <div className="pt-4 border-t border-[rgba(255,255,255,0.06)]">
            <ProjectChecklist
              projectId={currentId}
              tasks={project.tasks}
              resolvedTasks={project.resolvedTasks}
              onToggle={toggleItem}
              onAdd={addItem}
              onRemove={removeItem}
              onPromote={promoteItem}
            />
          </div>

          {/* Assets */}
          <div className="pt-4 border-t border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Assets</h3>

              <button
                onClick={() => openAssetPicker({ type: 'attach' })}
                className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <Paperclip className="size-3" />
                Attach
              </button>
            </div>

            {project.resolvedAssets.length === 0 ? (
              <p className="text-[11px] text-zinc-600">No assets attached.</p>
            ) : (
              <div className="space-y-1.5">
                {project.resolvedAssets.some(asset => asset.missing) && (
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-snug text-amber-200/80">
                    Some attached assets could not be loaded. Detach broken references to clean up this project.
                  </div>
                )}
                {project.resolvedAssets.map((asset) => (
                  <div
                    key={asset.assetId}
                    className={`group flex items-start gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-zinc-800/40 ${asset.missing ? 'border border-amber-500/15 bg-amber-500/5' : ''}`}
                  >
                    <button
                      type="button"
                      disabled={asset.missing}
                      onClick={() => setPreviewAsset(asset)}
                      aria-label={`Open ${assetName(asset)}`}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left disabled:cursor-default"
                    >
                      <AssetThumb asset={asset} />
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p className="truncate text-[11px] leading-tight text-zinc-300">{assetName(asset)}</p>
                        {asset.description && (
                          <p className="mt-0.5 truncate text-[10px] text-zinc-600">{asset.description}</p>
                        )}
                        {asset.tags && asset.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {asset.tags.slice(0, 3).map(tag => (
                              <span key={tag} className="rounded bg-zinc-800/60 px-1 py-0.5 text-[9px] text-zinc-500">{tag}</span>
                            ))}
                          </div>
                        )}
                        {asset.missing && <span className="text-[10px] text-amber-500/70">can't find asset</span>}
                      </div>
                    </button>
                    <div className={`${asset.missing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} mt-0.5 flex shrink-0 items-center gap-1 transition-opacity`}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openAssetPicker({ type: 'relink', target: asset }) }}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        aria-label={`Relink ${assetName(asset)}`}
                      >
                        <Link2 className="size-3" />
                        Relink
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setAssetDetachError(null); setAssetDetachTarget(asset) }}
                        className={`${asset.missing ? 'text-amber-400/80' : 'text-zinc-600'} p-1 hover:text-red-400 transition-colors`}
                        aria-label={`Detach ${assetName(asset)}`}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

          </div>

          {/* Meta */}
          <div className="pt-4 border-t border-[rgba(255,255,255,0.06)]">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Details</h3>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-zinc-600">Created</span>
                <span className="text-zinc-400">{new Date(project.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-600">Updated</span>
                <span className="text-zinc-400">{new Date(project.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-600">ID</span>
                <span className="text-zinc-500 font-mono">{project.id.slice(0, 8)}</span>
              </div>
            </div>
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
