'use client'

/**
 * Project header (D11–D13): the title (renamed through the kit's rename
 * dialog), the status badge, ONE next-step button for the lifecycle, and a
 * ⋯ menu for Archive, Details and Delete. No status picker anywhere — every
 * transition carries the status it expects, so a stale page never clobbers.
 */
import { useState, type ReactNode } from 'react'
import { Archive, ArrowLeft, Info, Pencil, Trash } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
  Field,
  FieldLabel,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@makinbakin/sdk/ui'
import { AgentSelect, ConfirmDialog, KeyValue, PageHeader } from '@makinbakin/sdk/patterns'
import { toast } from '@makinbakin/sdk/hooks'
import { formatAge, formatDateTime } from '@makinbakin/sdk/utils'
import { ProjectStatusBadge } from './project-status-badge'
import { projectRequest } from '../lib/project-api'
import type { ProjectDetailData, ProjectStatus } from '../types'

export interface HeaderAgent {
  id: string
  name: string
  imageSrc?: string | null
}

interface NextStep {
  label: string
  to: ProjectStatus
  /** A confirmation to show first, or none for a direct step. */
  confirm?: { title: string; description: ReactNode; confirmLabel: string }
}

/** The one primary lifecycle action for a status (D11). */
export function nextStepFor(project: Pick<ProjectDetailData, 'status' | 'tasks' | 'archivedFrom'>, leadName: string): NextStep {
  switch (project.status) {
    case 'draft':
      return {
        label: 'Start project',
        to: 'active',
        confirm: {
          title: 'Start project?',
          description: `The project becomes active work. ${leadName} switches from shaping the plan to tracking its progress with you.`,
          confirmLabel: 'Start project',
        },
      }
    case 'active': {
      const open = project.tasks.filter(task => !task.checked).length
      return {
        label: 'Mark complete',
        to: 'completed',
        ...(open > 0 ? {
          confirm: {
            title: 'Mark complete?',
            description: `${open} of ${project.tasks.length} steps ${open === 1 ? 'isn\'t' : 'aren\'t'} done yet. You can reopen the project later.`,
            confirmLabel: 'Mark complete',
          },
        } : {}),
      }
    }
    case 'completed':
      return { label: 'Reopen', to: 'active' }
    case 'archived':
      return { label: 'Unarchive', to: project.archivedFrom ?? 'draft' }
  }
}

export function ProjectHeader({
  project,
  agents,
  onBack,
  onChanged,
  onDelete,
}: {
  project: ProjectDetailData
  agents: readonly HeaderAgent[]
  onBack: () => void
  onChanged: () => Promise<unknown>
  onDelete: () => void
}) {
  const leadName = agents.find(agent => agent.id === project.owner)?.name ?? (project.owner || 'The lead agent')
  const step = nextStepFor(project, leadName)
  const [confirming, setConfirming] = useState<NextStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const put = (patch: Record<string, string>, expected: Record<string, string>) =>
    projectRequest(encodeURIComponent(project.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, expected }),
    })

  const transition = async (to: ProjectStatus, fromDialog: boolean) => {
    setBusy(true)
    setConfirmError(null)
    try {
      await put({ status: to }, { status: project.status })
      setConfirming(null)
      await onChanged()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The project could not be updated. Try again.'
      if (fromDialog) setConfirmError(message)
      else toast(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runStep = (next: NextStep) => {
    if (next.confirm) {
      setConfirmError(null)
      setConfirming(next)
    } else {
      void transition(next.to, false)
    }
  }

  return (
    <>
      <PageHeader
        className="shrink-0"
        measure="wide"
        navigation={(
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to projects">
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        title={(
          <span className="inline-flex min-w-0 max-w-full items-center gap-bakin-1">
            <span className="min-w-0 [overflow-wrap:anywhere]">{project.title || 'Untitled project'}</span>
            <Tooltip>
              <TooltipTrigger
                render={<Button type="button" variant="ghost" size="icon-xs" aria-label="Rename project" className="text-bakin-text-muted" />}
                onClick={() => setRenaming(true)}
              >
                <Pencil aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Rename project</TooltipContent>
            </Tooltip>
          </span>
        )}
        meta={<ProjectStatusBadge status={project.status} />}
        actionsLabel="Project actions"
        actions={(
          <Button type="button" size="sm" disabled={busy} onClick={() => runStep(step)}>
            {step.label}
          </Button>
        )}
        overflowActionsLabel="More project actions"
        overflowActions={(
          <>
            {project.status !== 'archived' ? (
              <DropdownMenuItem onClick={() => { void transition('archived', false) }}>
                <Archive aria-hidden="true" />
                Archive
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => setDetailsOpen(true)}>
              <Info aria-hidden="true" />
              Details
            </DropdownMenuItem>
            <DropdownMenuItem variant="danger" onClick={onDelete}>
              <Trash aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      />

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.confirm?.title ?? ''}
        description={confirming?.confirm?.description}
        confirmLabel={confirming?.confirm?.confirmLabel}
        busyLabel="Saving…"
        confirmTone="primary"
        busy={busy}
        error={confirmError}
        onConfirm={() => { if (confirming) void transition(confirming.to, true) }}
        onCancel={() => { if (!busy) setConfirming(null) }}
      />

      {renaming ? (
        <RenameDialog
          title={project.title}
          onCancel={() => setRenaming(false)}
          onSave={async (title) => {
            await put({ title }, { title: project.title })
            setRenaming(false)
            await onChanged()
          }}
        />
      ) : null}

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Project details</DialogTitle>
          </DialogHeader>
          <LeadPicker
            project={project}
            agents={agents}
            onSave={async (owner) => {
              await put({ owner }, { owner: project.owner })
              await onChanged()
            }}
          />
          <KeyValue
            layout="rows"
            items={[
              { label: 'Created', value: formatDateTime(project.created) },
              { label: 'Updated', value: formatAge(project.updated) },
              { label: 'ID', value: project.id, mono: true },
            ]}
          />
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Rename through the kit form recipe (the chat precedent): Enter saves, Esc cancels. */
function RenameDialog({ title, onCancel, onSave }: { title: string; onCancel: () => void; onSave: (title: string) => Promise<void> }) {
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = draft.trim()

  const commit = async () => {
    if (!trimmed || saving) return
    if (trimmed === title) { onCancel(); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The title could not be saved. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
        </DialogHeader>
        <Field name="title">
          <FieldLabel>Project title</FieldLabel>
          <Input
            autoFocus
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void commit() } }}
          />
        </Field>
        {error ? <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={() => { void commit() }} disabled={!trimmed || saving}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Lead agent" is the UI name for the stored owner (D13). */
function LeadPicker({ project, agents, onSave }: { project: ProjectDetailData; agents: readonly HeaderAgent[]; onSave: (owner: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Field name="lead">
      <FieldLabel>Lead agent</FieldLabel>
      <AgentSelect
        value={project.owner}
        agents={[...agents]}
        ariaLabel="Lead agent"
        disabled={saving}
        onValueChange={(owner: string) => {
          if (owner === project.owner) return
          setSaving(true)
          setError(null)
          onSave(owner)
            .catch(err => setError(err instanceof Error ? err.message : 'The lead agent could not be changed.'))
            .finally(() => setSaving(false))
        }}
      />
      {error ? <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </Field>
  )
}
