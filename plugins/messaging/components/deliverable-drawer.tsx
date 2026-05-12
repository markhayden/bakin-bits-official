'use client'

import { useEffect, useMemo, useState } from 'react'
import { AgentAvatar } from "@bakin/sdk/components"
import { BakinDrawer } from "@bakin/sdk/components"
import { Badge } from "@bakin/sdk/ui"
import { Button } from "@bakin/sdk/ui"
import { Textarea } from "@bakin/sdk/ui"
import { Separator } from "@bakin/sdk/ui"
import { AlertCircle, CalendarDays, Check, Clock, ImageIcon, Trash2, Video, X } from 'lucide-react'
import type { AssetRequirement, ContentTypeOption, Deliverable } from '../types'
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
  if (requirement === 'image' && !deliverable.draft.imageFilename) return 'Required image asset missing'
  if (requirement === 'video' && !deliverable.draft.videoFilename) return 'Required video asset missing'
  return null
}

function assetUrl(filename: string): string {
  return `/api/assets/${encodeURIComponent(filename)}`
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

export function DeliverableDrawer({ deliverable, open, onClose, onUpdated }: DeliverableDrawerProps) {
  const contentTypes = useContentTypes()
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

  return (
    <BakinDrawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      title={deliverable.title}
    >
      <div className="space-y-5">
        <section className="flex items-start gap-4 rounded-md border border-border bg-surface p-4">
          <AgentAvatar agentId={deliverable.agent} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <DeliverableStatusBadge status={deliverable.status} />
              <Badge variant="outline">{deliverable.channel}</Badge>
              <Badge variant="outline">{getContentTypeLabel(deliverable.contentType, contentTypes)}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{deliverable.brief}</p>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md bg-surface p-3">
            <div className="flex items-center gap-1.5 text-[11px] uppercase text-muted-foreground">
              <CalendarDays className="size-3" />
              Publish
            </div>
            <div className="mt-1 text-sm font-medium">{formatDateTime(deliverable.publishAt)}</div>
          </div>
          <div className="rounded-md bg-surface p-3">
            <div className="flex items-center gap-1.5 text-[11px] uppercase text-muted-foreground">
              <Clock className="size-3" />
              Prep
            </div>
            <div className="mt-1 text-sm font-medium">
              {formatDateTime(deliverable.prepStartAtOverride ?? deliverable.prepStartAt)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
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
            variant={confirmingDelete ? 'destructive' : 'outline'}
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

        {actionError && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {missingRequirement && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{missingRequirement}</span>
          </div>
        )}

        {rejecting && (
          <div className="space-y-2">
            <Textarea
              value={rejectionNote}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setRejectionNote(event.target.value)}
              placeholder="Change request note"
              className="min-h-[84px] bg-surface"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRejecting(false)}>Cancel</Button>
              <Button variant="destructive" disabled={actionLoading} onClick={handleReject}>Send changes</Button>
            </div>
          </div>
        )}

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Draft</h3>
          {deliverable.draft.caption && (
            <p className="whitespace-pre-wrap rounded-md bg-surface p-3 text-sm">{deliverable.draft.caption}</p>
          )}
          {deliverable.draft.imagePrompt && (
            <div className="rounded-md bg-surface p-3">
              <div className="text-[11px] uppercase text-muted-foreground">Image prompt</div>
              <p className="mt-1 text-sm">{deliverable.draft.imagePrompt}</p>
            </div>
          )}
          {deliverable.draft.videoPrompt && (
            <div className="rounded-md bg-surface p-3">
              <div className="text-[11px] uppercase text-muted-foreground">Video prompt</div>
              <p className="mt-1 text-sm">{deliverable.draft.videoPrompt}</p>
            </div>
          )}
          {deliverable.draft.imageFilename && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ImageIcon className="size-3.5" />
                {deliverable.draft.imageFilename}
              </div>
              <img
                src={assetUrl(deliverable.draft.imageFilename)}
                alt={deliverable.draft.imageFilename}
                className="max-h-72 rounded-md object-cover"
              />
            </div>
          )}
          {deliverable.draft.videoFilename && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Video className="size-3.5" />
                {deliverable.draft.videoFilename}
              </div>
              <video
                src={assetUrl(deliverable.draft.videoFilename)}
                controls
                className="max-h-72 rounded-md"
              />
            </div>
          )}
          {deliverable.draft.agentNotes && (
            <div className="rounded-md bg-surface p-3">
              <div className="text-[11px] uppercase text-muted-foreground">Agent notes</div>
              <p className="mt-1 text-sm text-muted-foreground">{deliverable.draft.agentNotes}</p>
            </div>
          )}
          {!deliverable.draft.caption &&
            !deliverable.draft.imagePrompt &&
            !deliverable.draft.videoPrompt &&
            !deliverable.draft.imageFilename &&
            !deliverable.draft.videoFilename &&
            !deliverable.draft.agentNotes && (
              <p className="text-sm text-muted-foreground">No draft yet</p>
            )}
        </section>

        {deliverable.rejectionNote && (
          <div className="rounded-md border border-orange-500/30 bg-orange-500/10 p-3">
            <div className="text-sm font-medium text-orange-300">Change request</div>
            <p className="mt-1 text-sm text-orange-200">{deliverable.rejectionNote}</p>
          </div>
        )}

        {deliverable.failureReason && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
            <div className="text-sm font-medium text-red-300">Failure reason</div>
            <p className="mt-1 text-sm text-red-200">{deliverable.failureReason}</p>
          </div>
        )}
      </div>
    </BakinDrawer>
  )
}
