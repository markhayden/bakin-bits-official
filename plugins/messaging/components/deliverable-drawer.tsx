'use client'

import { useEffect, useMemo, useState } from 'react'
import { AgentAvatar } from "@makinbakin/sdk/patterns"
import { useAgentList } from "@makinbakin/sdk/hooks"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Drawer,
  Separator,
  Textarea,
} from "@makinbakin/sdk/ui"
import { AlertCircle, CalendarDays, Check, Clock, ImageIcon, RefreshCcw, RotateCcw, Trash2, Video, X } from 'lucide-react'
import type { AssetRequirement, ContentTypeOption, Deliverable, DeliverableFailureStage } from '../types'
import { getContentTypeLabel, useContentTypes } from '../hooks/use-content-types'
import { DeliverableStatusBadge } from './deliverable-status-badge'

interface DeliverableDrawerProps {
  deliverable: Deliverable | null
  open: boolean
  onClose: () => void
  onUpdated?: () => void
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function requirementMissing(deliverable: Deliverable, requirement: AssetRequirement | undefined): string | null {
  if (requirement === 'image' && !deliverable.draft.imageAssetId) return 'Required image asset missing'
  if (requirement === 'video' && !deliverable.draft.videoAssetId) return 'Required video asset missing'
  return null
}

function assetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`
}

function contentTypeFor(deliverable: Deliverable, contentTypes: ContentTypeOption[]): ContentTypeOption {
  return contentTypes.find((type) => type.id === deliverable.contentType)
    ?? { id: deliverable.contentType, label: deliverable.contentType, assetRequirement: 'none' }
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

function inferFailureStage(deliverable: Deliverable): DeliverableFailureStage | null {
  if (deliverable.failureStage) return deliverable.failureStage
  const reason = deliverable.failureReason ?? ''
  if (reason.startsWith('workflow.complete fired')) return 'workflow_handoff'
  if (reason.startsWith('Channel delivery')) return 'delivery'
  if (reason.includes('asset missing') || reason.includes('not resolvable')) return 'validation'
  return null
}

function recoveryActionFor(deliverable: Deliverable): { label: string; route: string; confirm?: string; icon: 'restore' | 'retry' } | null {
  if (deliverable.status !== 'failed') return null
  const stage = inferFailureStage(deliverable)
  if (stage === 'workflow_handoff') {
    return { label: 'Restore approval', route: 'restore-approval', icon: 'restore' }
  }
  if (stage === 'validation' || stage === 'workflow') {
    return { label: 'Reopen prep', route: 'reopen-prep', icon: 'restore' }
  }
  if (stage === 'delivery') {
    return {
      label: 'Retry delivery',
      route: 'retry-delivery',
      icon: 'retry',
      confirm: `Retry delivery to ${deliverable.channel}? This may publish or send the content externally.`,
    }
  }
  return null
}

export function DeliverableDrawer({ deliverable, open, onClose, onUpdated }: DeliverableDrawerProps) {
  const contentTypes = useContentTypes()
  const agents = useAgentList()
  const agentIdentity = useMemo(() => {
    if (!deliverable) return null
    const agent = agents.find((candidate) => candidate.id === deliverable.agent)
    return {
      id: deliverable.agent,
      name: agent?.name || deliverable.agent,
      imageSrc: agent?.headshot || null,
    }
  }, [agents, deliverable])
  const [rejecting, setRejecting] = useState(false)
  const [rejectionNote, setRejectionNote] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    setRejecting(false)
    setRejectionNote('')
    setConfirmingDelete(false)
    setActionError(null)
  }, [deliverable?.id, open])

  const contentType = useMemo(
    () => deliverable ? contentTypeFor(deliverable, contentTypes) : null,
    [contentTypes, deliverable],
  )
  const missingRequirement = deliverable && contentType
    ? requirementMissing(deliverable, contentType.assetRequirement)
    : null

  if (!deliverable || !contentType) return null

  const canApprove = deliverable.status === 'in_review'
  const canApproveAndPublishNow = deliverable.status === 'overdue'
  const canReject = deliverable.status === 'in_review'
  const approveDisabled = actionLoading || Boolean(missingRequirement)
  const recoveryAction = recoveryActionFor(deliverable)

  const handleApprove = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      const encoded = encodeURIComponent(deliverable.id)
      const path = canApproveAndPublishNow ? 'approve-and-publish-now' : 'approve'
      const response = await fetch(`/api/plugins/messaging/deliverables/${encoded}/${path}?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        setActionError(await readErrorMessage(response, 'Could not approve this content piece.'))
        return
      }
      await onUpdated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const handleReject = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      const encoded = encodeURIComponent(deliverable.id)
      const response = await fetch(`/api/plugins/messaging/deliverables/${encoded}/reject?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: rejectionNote }),
      })
      if (!response.ok) {
        setActionError(await readErrorMessage(response, 'Could not request changes for this content piece.'))
        return
      }
      await onUpdated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      setActionError(null)
      return
    }

    setActionLoading(true)
    setActionError(null)
    try {
      const encoded = encodeURIComponent(deliverable.id)
      const response = await fetch(`/api/plugins/messaging/deliverables/${encoded}?id=${encoded}&deleteLinkedTasks=true`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setActionError(await readErrorMessage(response, 'Could not delete this content piece.'))
        return
      }
      await onUpdated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const handleRecovery = async () => {
    if (!recoveryAction) return
    if (recoveryAction.confirm && !window.confirm(recoveryAction.confirm)) return

    setActionLoading(true)
    setActionError(null)
    try {
      const encoded = encodeURIComponent(deliverable.id)
      const response = await fetch(`/api/plugins/messaging/deliverables/${encoded}/${recoveryAction.route}?id=${encoded}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        setActionError(await readErrorMessage(response, `Could not ${recoveryAction.label.toLowerCase()}.`))
        return
      }
      await onUpdated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      title={deliverable.title}
    >
      <div className="space-y-5">
        <section className="flex items-start gap-bakin-4 rounded-md border border-bakin-border-subtle/30 bg-bakin-canvas-default p-bakin-4">
          {agentIdentity && <AgentAvatar agent={agentIdentity} size="lg" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-bakin-2">
              <DeliverableStatusBadge status={deliverable.status} />
              <Badge variant="outline">{deliverable.channel}</Badge>
              <Badge variant="outline">{getContentTypeLabel(deliverable.contentType, contentTypes)}</Badge>
            </div>
            <p className="mt-bakin-2 text-sm text-bakin-text-muted">{deliverable.brief}</p>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-bakin-3">
          <div className="rounded-md bg-bakin-canvas-default p-bakin-3">
            <div className="flex items-center gap-1.5 text-bakin-typography-size-meta uppercase text-bakin-text-muted">
              <CalendarDays className="size-bakin-3" />
              Publish
            </div>
            <div className="mt-bakin-1 text-sm font-bakin-typography-weight-medium">{formatDateTime(deliverable.publishAt)}</div>
          </div>
          <div className="rounded-md bg-bakin-canvas-default p-bakin-3">
            <div className="flex items-center gap-1.5 text-bakin-typography-size-meta uppercase text-bakin-text-muted">
              <Clock className="size-bakin-3" />
              Prep
            </div>
            <div className="mt-bakin-1 text-sm font-bakin-typography-weight-medium">
              {formatDateTime(deliverable.prepStartAtOverride ?? deliverable.prepStartAt)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-bakin-2">
          {recoveryAction && (
            <Button size="sm" onClick={handleRecovery} disabled={actionLoading}>
              {recoveryAction.icon === 'retry'
                ? <RefreshCcw className="size-3.5" data-icon="inline-start" />
                : <RotateCcw className="size-3.5" data-icon="inline-start" />}
              {recoveryAction.label}
            </Button>
          )}
          {(canApprove || canApproveAndPublishNow) && (
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={approveDisabled}
              title={missingRequirement ?? undefined}
            >
              <Check className="size-3.5" data-icon="inline-start" />
              {canApproveAndPublishNow ? 'Approve & publish now' : 'Approve'}
            </Button>
          )}
          {canReject && (
            <Button size="sm" variant="outline" onClick={() => setRejecting((value) => !value)}>
              <X className="size-3.5" data-icon="inline-start" />
              Request changes
            </Button>
          )}
          <Button
            size="sm"
            variant={confirmingDelete ? 'danger' : 'outline'}
            disabled={actionLoading}
            onClick={handleDelete}
          >
            <Trash2 className="size-3.5" data-icon="inline-start" />
            {confirmingDelete ? 'Confirm delete' : 'Delete'}
          </Button>
          {confirmingDelete && (
            <Button
              size="sm"
              variant="ghost"
              disabled={actionLoading}
              onClick={() => {
                setConfirmingDelete(false)
                setActionError(null)
              }}
            >
              Cancel
            </Button>
          )}
        </div>

        {deliverable.failureReason && (
          <Alert tone="danger">
            <AlertTitle>Failure reason</AlertTitle>
            <AlertDescription>{deliverable.failureReason}</AlertDescription>
          </Alert>
        )}

        {actionError && (
          <Alert tone="danger">
            <AlertCircle className="size-bakin-4" />
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {missingRequirement && (
          <Alert tone="attention">
            <AlertCircle className="size-bakin-4" />
            <AlertDescription>{missingRequirement}</AlertDescription>
          </Alert>
        )}

        {rejecting && (
          <div className="space-y-bakin-2">
            <Textarea
              value={rejectionNote}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setRejectionNote(event.target.value)}
              placeholder="Change request note"
              className="min-h-21 bg-bakin-canvas-default"
            />
            <div className="flex justify-end gap-bakin-2">
              <Button variant="outline" onClick={() => setRejecting(false)}>Cancel</Button>
              <Button variant="danger" disabled={actionLoading} onClick={handleReject}>Send changes</Button>
            </div>
          </div>
        )}

        <Separator />

        <section className="space-y-bakin-3">
          <h3 className="text-sm font-bakin-typography-weight-medium">Draft</h3>
          {deliverable.draft.caption && (
            <p className="whitespace-pre-wrap rounded-md bg-bakin-canvas-default p-bakin-3 text-sm">{deliverable.draft.caption}</p>
          )}
          {deliverable.draft.imagePrompt && (
            <div className="rounded-md bg-bakin-canvas-default p-bakin-3">
              <div className="text-bakin-typography-size-meta uppercase text-bakin-text-muted">Image prompt</div>
              <p className="mt-bakin-1 text-sm">{deliverable.draft.imagePrompt}</p>
            </div>
          )}
          {deliverable.draft.videoPrompt && (
            <div className="rounded-md bg-bakin-canvas-default p-bakin-3">
              <div className="text-bakin-typography-size-meta uppercase text-bakin-text-muted">Video prompt</div>
              <p className="mt-bakin-1 text-sm">{deliverable.draft.videoPrompt}</p>
            </div>
          )}
          {deliverable.draft.imageAssetId && (
            <div>
              <div className="mb-bakin-1 flex items-center gap-1.5 text-xs text-bakin-text-muted">
                <ImageIcon className="size-3.5" />
                {deliverable.draft.imageAssetId}
              </div>
              <img
                src={assetUrl(deliverable.draft.imageAssetId)}
                alt={deliverable.draft.imageAssetId}
                className="max-h-72 rounded-md object-cover"
              />
            </div>
          )}
          {deliverable.draft.videoAssetId && (
            <div>
              <div className="mb-bakin-1 flex items-center gap-1.5 text-xs text-bakin-text-muted">
                <Video className="size-3.5" />
                {deliverable.draft.videoAssetId}
              </div>
              <video
                src={assetUrl(deliverable.draft.videoAssetId)}
                controls
                className="max-h-72 rounded-md"
              />
            </div>
          )}
          {deliverable.draft.agentNotes && (
            <div className="rounded-md bg-bakin-canvas-default p-bakin-3">
              <div className="text-bakin-typography-size-meta uppercase text-bakin-text-muted">Agent notes</div>
              <p className="mt-bakin-1 text-sm text-bakin-text-muted">{deliverable.draft.agentNotes}</p>
            </div>
          )}
          {!deliverable.draft.caption &&
            !deliverable.draft.imagePrompt &&
            !deliverable.draft.videoPrompt &&
            !deliverable.draft.imageAssetId &&
            !deliverable.draft.videoAssetId &&
            !deliverable.draft.agentNotes && (
              <p className="text-sm text-bakin-text-muted">No draft yet</p>
            )}
        </section>

        {deliverable.rejectionNote && (
          <Alert tone="attention">
            <AlertTitle>Change request</AlertTitle>
            <AlertDescription>{deliverable.rejectionNote}</AlertDescription>
          </Alert>
        )}

      </div>
    </Drawer>
  )
}
