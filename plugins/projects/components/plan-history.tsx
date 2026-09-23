'use client'

/**
 * PlanHistoryPanel — the "Changes" view for a project plan (bakin#703).
 * Lightweight by design: a snapshot list (newest first), a line-level
 * added/removed diff of the CURRENT body against the selected snapshot
 * (default: the previous version), and one-click restore behind a confirm
 * modal. Restore is never destructive — the server snapshots the current
 * body before applying (deliberately not a document-management system).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@makinbakin/sdk/hooks'
import { ConfirmDialog } from '@makinbakin/sdk/patterns'
import {
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SystemState,
  Text,
} from '@makinbakin/sdk/ui'
import { formatDateTime } from '@makinbakin/sdk/utils'
import type { PlanSnapshot } from '../types'
import { diffLines } from '../lib/line-diff'
import { projectRequest } from '../lib/project-api'
import type { ProjectHistory } from '../hooks/use-project-history'
import { HistoryFeedback } from './history-feedback'

function snapshotLabel(snapshot: PlanSnapshot): string {
  return `${formatDateTime(snapshot.ts)} · ${snapshot.author === 'agent' ? 'agent edit' : 'your edit'}`
}

export function PlanHistoryPanel({ projectId, currentBody, onRestored, historyState }: {
  projectId: string
  historyState: ProjectHistory
  /** The live plan body (diff target). */
  currentBody: string
  /** Fired after a successful restore so the host refetches the project. */
  onRestored: () => void | Promise<void>
}) {
  const { history, loading, error, refresh } = historyState
  const [selectedTs, setSelectedTs] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<{ projectId: string; index: number; snapshot: PlanSnapshot } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const owner = useRef(projectId)
  owner.current = projectId
  useEffect(() => {
    owner.current = projectId
    setSelectedTs(null); setConfirmRestore(null); setRestoreError(null); setRestoring(false)
    return () => { owner.current = '' }
  }, [projectId])
  const selectedIndex = history?.findIndex(snapshot => snapshot.ts === selectedTs) ?? -1
  const selected = history?.length ? (selectedIndex < 0 ? history.length - 1 : selectedIndex) : null
  const snapshot = selected !== null ? history?.[selected] : undefined

  const restore = async () => {
    const captured = confirmRestore
    if (!captured || restoring || captured.projectId !== projectId) return
    setRestoring(true)
    setRestoreError(null)
    try {
      const body = await projectRequest(`${encodeURIComponent(captured.projectId)}/history/${captured.index}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedTs: captured.snapshot.ts }),
      }) as { changed?: boolean }
      if (owner.current !== captured.projectId) return
      if (body.changed === false) toast('Plan already matches that version', 'info')
      setConfirmRestore(null)
      await onRestored()
      await refresh()
    } catch (error) {
      if (owner.current === captured.projectId) setRestoreError(error instanceof Error ? error.message : 'Restore failed. Try again.')
    } finally {
      if (owner.current === captured.projectId) setRestoring(false)
    }
  }

  // Memoized: the parent re-renders per streamed chunk, and LCS is O(n·m).
  const DIFF_LINE_LIMIT = 5000
  const diffResult = useMemo(() => {
    if (!snapshot) return { diff: [] as ReturnType<typeof diffLines>, tooLarge: false }
    const total = snapshot.body.split('\n').length + currentBody.split('\n').length
    if (total > DIFF_LINE_LIMIT) return { diff: [] as ReturnType<typeof diffLines>, tooLarge: true }
    return { diff: diffLines(snapshot.body, currentBody), tooLarge: false }
  }, [snapshot, currentBody])
  const diff = diffResult.diff
  const changed = diff.filter((l) => l.type !== 'same').length

  if (history === null) return <HistoryFeedback state={historyState} />
  if (history.length === 0 && !error && !loading) {
    return (
      <SystemState
        kind="initial-empty"
        scope="page"
        headingLevel={3}
        title="No plan versions yet"
        description="Edits (yours or the agent's) snapshot the previous version here."
      />
    )
  }

  return (
    <div data-testid="plan-history" className="grid gap-bakin-3">
      <HistoryFeedback state={historyState} />
      <div className="flex flex-wrap items-end gap-bakin-3">
        <Field name="compareWith">
          <FieldLabel htmlFor="plan-history-picker">Compare current with</FieldLabel>
          <Select
            data-testid="plan-history-picker"
            value={String(selected ?? '')}
            onValueChange={(value: string) => setSelectedTs(history[Number(value)]?.ts ?? null)}
          >
            <SelectTrigger id="plan-history-picker" size="sm" data-testid="plan-history-picker">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...history.keys()].reverse().map((index) => (
                <SelectItem key={index} value={String(index)}>
                  {snapshotLabel(history[index])}{index === history.length - 1 ? ' (previous)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {snapshot && (
          <Button
            variant="outline"
            size="sm"
            data-testid="plan-history-restore"
            disabled={loading || !!error || restoring}
            onClick={() => { if (selected !== null && snapshot) { setRestoreError(null); setConfirmRestore({ projectId, index: selected, snapshot }) } }}
          >
            Restore this version
          </Button>
        )}
        <Text size="meta" tone="muted">{diffResult.tooLarge ? 'Comparison unavailable' : changed === 0 ? 'No changes' : `${changed} changed ${changed === 1 ? 'line' : 'lines'}`}</Text>
      </div>

      <div role="region" aria-label="Plan line comparison" tabIndex={0} data-testid="plan-history-diff" className="focus-visible:outline-2 focus-visible:outline-bakin-focus-ring focus-visible:-outline-offset-2 max-h-96 overflow-auto rounded-bakin-surface border border-bakin-border-subtle bg-bakin-surface-default/60 font-bakin-typography-family-mono text-bakin-typography-size-meta leading-5">
        {diffResult.tooLarge && (
          <Text as="p" size="meta" tone="muted" className="px-bakin-3 py-bakin-2">Diff too large to render inline (over {DIFF_LINE_LIMIT.toLocaleString()} lines) — restore still works.</Text>
        )}
        {diff.map((line, i) => (
          <div
            key={i}
            data-diff-type={line.type}
            className={
              line.type === 'added'
                ? 'bg-bakin-action-primary-background/10 px-bakin-3 text-bakin-action-primary-background'
                : line.type === 'removed'
                  ? 'bg-bakin-signal-danger/10 px-bakin-3 text-bakin-signal-danger line-through decoration-bakin-signal-danger/40'
                  : 'px-bakin-3 text-bakin-text-muted'
            }
          >
            <Text size="meta" tone="muted" className="mr-bakin-2 select-none">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</Text>
            {line.text || ' '}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmRestore !== null && confirmRestore.projectId === projectId}
        title="Restore this plan version?"
        description={confirmRestore !== null
          ? `The plan body returns to ${snapshotLabel(confirmRestore.snapshot)}. Your current version is kept as a new snapshot, so nothing is lost.`
          : ''}
        confirmLabel="Restore"
        busyLabel="Restoring…"
        busy={restoring}
        error={restoreError}
        confirmTestId="plan-history-restore-confirm"
        onConfirm={() => { void restore() }}
        onCancel={() => { if (!restoring) setConfirmRestore(null) }}
      />
    </div>
  )
}
