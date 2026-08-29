'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AgentAvatar, ConfirmDialog, StatGroup, StatTile } from "@makinbakin/sdk/patterns"
import { useAgentList } from "@makinbakin/sdk/hooks"
import { Panel } from "@makinbakin/sdk/layout"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Drawer,
  Field,
  FieldControl,
  FieldLabel,
  Form,
  FormActions,
  Overline,
  Separator,
  SubmitButton,
  Text,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@makinbakin/sdk/ui"
import { formatDateTime } from "@makinbakin/sdk/utils"
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
  const [confirmingRecovery, setConfirmingRecovery] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    setRejecting(false)
    setRejectionNote('')
    setConfirmingDelete(false)
    setConfirmingRecovery(false)
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
  const draft = deliverable.draft
  const hasDraft = Boolean(
    draft.caption || draft.imagePrompt || draft.videoPrompt || draft.imageAssetId || draft.videoAssetId || draft.agentNotes,
  )

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

  const handleReject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
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
      setConfirmingDelete(false)
      await onUpdated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const runRecovery = async () => {
    if (!recoveryAction) return
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
      setConfirmingRecovery(false)
      await onUpdated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const handleRecovery = () => {
    if (!recoveryAction) return
    if (recoveryAction.confirm) {
      setActionError(null)
      setConfirmingRecovery(true)
      return
    }
    void runRecovery()
  }

  const approveLabel = canApproveAndPublishNow ? 'Approve & publish now' : 'Approve'
  const approveButton = (
    <Button
      size="sm"
      onClick={handleApprove}
      disabled={approveDisabled}
      focusableWhenDisabled={Boolean(missingRequirement)}
    >
      <Check data-icon="inline-start" aria-hidden="true" />
      {approveLabel}
    </Button>
  )

  return (
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      title={deliverable.title}
    >
      <div className="space-y-5">
        <Panel as="section" className="flex items-start gap-bakin-4">
          {agentIdentity && <AgentAvatar agent={agentIdentity} size="lg" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-bakin-2">
              <DeliverableStatusBadge status={deliverable.status} />
              <Badge variant="outline">{deliverable.channel}</Badge>
              <Badge variant="outline">{getContentTypeLabel(deliverable.contentType, contentTypes)}</Badge>
            </div>
            <Text as="p" tone="muted" className="mt-bakin-2">{deliverable.brief}</Text>
          </div>
        </Panel>

        <StatGroup label="Schedule" className="grid grid-cols-2">
          <StatTile icon={CalendarDays} label="Publish" value={formatDateTime(deliverable.publishAt)} variant="surface" />
          <StatTile
            icon={Clock}
            label="Prep"
            value={formatDateTime(deliverable.prepStartAtOverride ?? deliverable.prepStartAt)}
            variant="surface"
          />
        </StatGroup>

        <div className="flex flex-wrap gap-bakin-2">
          {recoveryAction && (
            <Button size="sm" onClick={handleRecovery} disabled={actionLoading}>
              {recoveryAction.icon === 'retry'
                ? <RefreshCcw data-icon="inline-start" aria-hidden="true" />
                : <RotateCcw data-icon="inline-start" aria-hidden="true" />}
              {recoveryAction.label}
            </Button>
          )}
          {(canApprove || canApproveAndPublishNow) && (
            missingRequirement ? (
              <Tooltip>
                <TooltipTrigger render={approveButton} />
                <TooltipContent>{missingRequirement}</TooltipContent>
              </Tooltip>
            ) : approveButton
          )}
          {canReject && (
            <Button size="sm" variant="outline" aria-expanded={rejecting} onClick={() => setRejecting((value) => !value)}>
              <X data-icon="inline-start" aria-hidden="true" />
              Request changes
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={actionLoading}
            onClick={() => {
              setActionError(null)
              setConfirmingDelete(true)
            }}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Delete
          </Button>
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
          <Form busy={actionLoading} onSubmit={handleReject} aria-label="Request changes form">
            <Field>
              <FieldLabel htmlFor="deliverable-rejection-note">Change request note</FieldLabel>
              <FieldControl
                render={(
                  <Textarea
                    id="deliverable-rejection-note"
                    value={rejectionNote}
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setRejectionNote(event.target.value)}
                    placeholder="What should change before this piece is approved?"
                    className="min-h-21"
                  />
                )}
              />
            </Field>
            <FormActions>
              <Button type="button" variant="outline" onClick={() => setRejecting(false)}>Cancel</Button>
              <SubmitButton variant="danger" busyLabel="Sending...">Send changes</SubmitButton>
            </FormActions>
          </Form>
        )}

        <Separator />

        <section className="space-y-bakin-3">
          <h3>Draft</h3>
          {draft.caption && (
            <Panel padding="compact">
              <Text as="p" className="whitespace-pre-wrap">{draft.caption}</Text>
            </Panel>
          )}
          {draft.imagePrompt && (
            <Panel padding="compact">
              <Overline as="div">Image prompt</Overline>
              <Text as="p" className="mt-bakin-1">{draft.imagePrompt}</Text>
            </Panel>
          )}
          {draft.videoPrompt && (
            <Panel padding="compact">
              <Overline as="div">Video prompt</Overline>
              <Text as="p" className="mt-bakin-1">{draft.videoPrompt}</Text>
            </Panel>
          )}
          {draft.imageAssetId && (
            <div>
              <Text as="div" size="meta" tone="muted" className="mb-bakin-1 flex items-center gap-bakin-2">
                <ImageIcon className="size-3.5" aria-hidden="true" />
                {draft.imageAssetId}
              </Text>
              <img
                src={assetUrl(draft.imageAssetId)}
                alt={draft.imageAssetId}
                className="max-h-72 rounded-bakin-surface object-cover"
              />
            </div>
          )}
          {draft.videoAssetId && (
            <div>
              <Text as="div" size="meta" tone="muted" className="mb-bakin-1 flex items-center gap-bakin-2">
                <Video className="size-3.5" aria-hidden="true" />
                {draft.videoAssetId}
              </Text>
              <video
                src={assetUrl(draft.videoAssetId)}
                controls
                className="max-h-72 rounded-bakin-surface"
              />
            </div>
          )}
          {draft.agentNotes && (
            <Panel padding="compact">
              <Overline as="div">Agent notes</Overline>
              <Text as="p" tone="muted" className="mt-bakin-1">{draft.agentNotes}</Text>
            </Panel>
          )}
          {!hasDraft && <Text as="p" tone="muted">No draft yet</Text>}
        </section>

        {deliverable.rejectionNote && (
          <Alert tone="attention">
            <AlertTitle>Change request</AlertTitle>
            <AlertDescription>{deliverable.rejectionNote}</AlertDescription>
          </Alert>
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this content piece?"
        description="This removes the content piece and any linked board task created for it."
        confirmLabel="Delete content piece"
        busyLabel="Deleting..."
        confirmTone="danger"
        busy={actionLoading}
        error={actionError}
        onConfirm={handleDelete}
        onCancel={() => {
          if (actionLoading) return
          setActionError(null)
          setConfirmingDelete(false)
        }}
      >
        <Text as="p" size="meta" tone="muted" className="truncate">{deliverable.title}</Text>
      </ConfirmDialog>

      {recoveryAction?.confirm && (
        <ConfirmDialog
          open={confirmingRecovery}
          title={`${recoveryAction.label}?`}
          description={recoveryAction.confirm}
          confirmLabel={recoveryAction.label}
          busyLabel="Retrying..."
          confirmTone="primary"
          busy={actionLoading}
          error={actionError}
          onConfirm={() => { void runRecovery() }}
          onCancel={() => {
            if (actionLoading) return
            setActionError(null)
            setConfirmingRecovery(false)
          }}
        />
      )}
    </Drawer>
  )
}
