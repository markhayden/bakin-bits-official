'use client'

/**
 * Project header (D11–D13, D27, D29): the title (renamed through the kit's
 * rename dialog), the status badge (+ "Paused" while check-ins are paused),
 * ONE next-step button for the lifecycle, and a ⋯ menu for Pause/Resume
 * check-ins, Archive, Details and Delete. No status picker anywhere — every
 * transition carries the status it expects, so a stale page never clobbers.
 */
import { useState, type ReactNode } from 'react'
import { Archive, ArrowLeft, Info, Pause, Pencil, Play, Trash } from 'lucide-react'
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
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { AgentSelect, ConfirmDialog, KeyValue, PageHeader, StatusBadge } from '@makinbakin/sdk/patterns'
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
  /** The status this step was offered from — the write's expected value. */
  from: ProjectStatus
  to: ProjectStatus
  /** A confirmation to show first, or none for a direct step. */
  confirm?: { title: string; description: ReactNode; confirmLabel: string }
}

const UNFINISHED_LISTED = 5

/** The one primary lifecycle action for a status (D11). */
export function nextStepFor(
  project: Pick<ProjectDetailData, 'status' | 'tasks' | 'archivedFrom'>,
  leadName: string,
  opts: { onReviewSteps?: () => void } = {},
): NextStep {
  switch (project.status) {
    case 'draft': {
      const steps = project.tasks.length
      // The hand-off (D27): Start gives the lead the wheel.
      return {
        label: 'Start project',
        from: 'draft',
        to: 'active',
        confirm: {
          title: 'Start project?',
          description: (
            <Stack gap="dense">
              <span>
                {leadName} takes it from here — sends steps to the board, assigns each to the right agent or keeps it, and checks in as work moves. You&apos;ll be asked when a decision or sign-off is needed.
              </span>
              <Inline gap="dense">
                <span>{steps === 0 ? `No steps yet — ${leadName} breaks the plan down first.` : `${steps} ${steps === 1 ? 'step' : 'steps'} in the plan.`}</span>
                {steps > 0 && opts.onReviewSteps ? (
                  <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={opts.onReviewSteps}>Review steps first</Button>
                ) : null}
              </Inline>
            </Stack>
          ),
          confirmLabel: 'Start project',
        },
      }
    }
    case 'active': {
      const unfinished = project.tasks.filter(task => !task.checked)
      const listed = unfinished.slice(0, UNFINISHED_LISTED)
      const more = unfinished.length - listed.length
      return {
        label: 'Mark complete',
        from: 'active',
        to: 'completed',
        // D28: name what is not done before completing anyway.
        ...(unfinished.length > 0 ? {
          confirm: {
            title: 'Mark complete?',
            description: (
              <Stack gap="dense">
                <span>{unfinished.length} {unfinished.length === 1 ? 'step isn\'t' : 'steps aren\'t'} done — complete anyway? You can reopen the project later.</span>
                <ul className="list-disc ps-bakin-4">
                  {listed.map(task => <li key={task.id} className="[overflow-wrap:anywhere]">{task.title}</li>)}
                  {more > 0 ? <li>and {more} more</li> : null}
                </ul>
              </Stack>
            ),
            confirmLabel: 'Complete anyway',
          },
        } : {}),
      }
    }
    case 'completed':
      return { label: 'Reopen', from: 'completed', to: 'active' }
    case 'archived':
      return { label: 'Unarchive', from: 'archived', to: project.archivedFrom ?? 'draft' }
  }
}

export function ProjectHeader({
  project,
  agents,
  onBack,
  onChanged,
  onDelete,
  onReviewSteps,
}: {
  project: ProjectDetailData
  agents: readonly HeaderAgent[]
  onBack: () => void
  onChanged: () => Promise<unknown>
  onDelete: () => void
  /** Leave the Start dialog for the Steps tab. */
  onReviewSteps?: () => void
}) {
  const leadName = agents.find(agent => agent.id === project.owner)?.name ?? (project.owner || 'The lead agent')
  const step = nextStepFor(project, leadName, onReviewSteps ? {
    onReviewSteps: () => {
      setConfirming(null)
      onReviewSteps()
    },
  } : {})
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

  // `from` is the status the action was OFFERED from, captured when it was
  // shown — a refresh in between must make the write conflict, not clobber.
  const transition = async (from: ProjectStatus, to: ProjectStatus, fromDialog: boolean) => {
    setBusy(true)
    setConfirmError(null)
    try {
      await put({ status: to }, { status: from })
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

  const setPaused = async (paused: boolean) => {
    try {
      await projectRequest(`${encodeURIComponent(project.id)}/steward/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      })
      await onChanged()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Check-ins could not be updated. Try again.', 'error')
    }
  }

  const runStep = (next: NextStep) => {
    if (next.confirm) {
      setConfirmError(null)
      setConfirming(next)
    } else {
      void transition(next.from, next.to, false)
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
        meta={(
          <Inline gap="dense" wrap={false}>
            <ProjectStatusBadge status={project.status} />
            {project.status === 'active' && project.stewardPaused ? (
              <StatusBadge tone="neutral" variant="outline" size="xs">Paused</StatusBadge>
            ) : null}
          </Inline>
        )}
        actionsLabel="Project actions"
        actions={(
          <Button type="button" size="sm" disabled={busy} onClick={() => runStep(step)}>
            {step.label}
          </Button>
        )}
        overflowActionsLabel="More project actions"
        overflowActions={(
          <>
            {project.status === 'active' ? (
              <DropdownMenuItem onClick={() => { void setPaused(!project.stewardPaused) }}>
                {project.stewardPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                {project.stewardPaused ? 'Resume check-ins' : 'Pause check-ins'}
              </DropdownMenuItem>
            ) : null}
            {project.status !== 'archived' ? (
              <DropdownMenuItem onClick={() => { void transition(project.status, 'archived', false) }}>
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
        onConfirm={() => { if (confirming) void transition(confirming.from, confirming.to, true) }}
        onCancel={() => { if (!busy) setConfirming(null) }}
      />

      {renaming ? (
        <RenameDialog
          title={project.title}
          onCancel={() => setRenaming(false)}
          onSave={async (title, baseline) => {
            await put({ title }, { title: baseline })
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
            onSave={async (owner, baseline) => {
              await put({ owner }, { owner: baseline })
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
function RenameDialog({ title, onCancel, onSave }: { title: string; onCancel: () => void; onSave: (title: string, baseline: string) => Promise<void> }) {
  // The title as it was when the dialog opened is the expected value: a
  // rename that lands meanwhile conflicts instead of being overwritten.
  const [baseline] = useState(title)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = draft.trim()

  const commit = async () => {
    if (!trimmed || saving) return
    if (trimmed === baseline) { onCancel(); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed, baseline)
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
function LeadPicker({ project, agents, onSave }: { project: ProjectDetailData; agents: readonly HeaderAgent[]; onSave: (owner: string, baseline: string) => Promise<void> }) {
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
          onSave(owner, project.owner)
            .catch(err => setError(err instanceof Error ? err.message : 'The lead agent could not be changed.'))
            .finally(() => setSaving(false))
        }}
      />
      {error ? <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </Field>
  )
}
