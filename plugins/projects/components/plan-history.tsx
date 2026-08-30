'use client'

/**
 * PlanHistoryPanel — the "Changes" view for a project plan (bakin#703).
 * Lightweight by design: a snapshot list (newest first), a line-level
 * added/removed diff of the CURRENT body against the selected snapshot
 * (default: the previous version), and one-click restore behind a confirm
 * modal. Restore is never destructive — the server snapshots the current
 * body before applying (deliberately not a document-management system).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
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

function snapshotLabel(snapshot: PlanSnapshot): string {
  return `${formatDateTime(snapshot.ts)} · ${snapshot.author === 'agent' ? 'agent edit' : 'your edit'}`
}

export function PlanHistoryPanel({ projectId, currentBody, onRestored }: {
  projectId: string
  /** The live plan body (diff target). */
  currentBody: string
  /** Fired after a successful restore so the host refetches the project. */
  onRestored: () => void
}) {
  const [history, setHistory] = useState<PlanSnapshot[] | null>(null)
  // Index into the STORED (oldest-first) array; default = newest snapshot.
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/plugins/projects/${projectId}/history`)
    if (!res.ok) {
      setHistory([])
      return
    }
    const body = (await res.json()) as { history?: PlanSnapshot[] }
    const list = Array.isArray(body.history) ? body.history : []
    setHistory(list)
    setSelected((prev) => (prev !== null && prev < list.length ? prev : list.length > 0 ? list.length - 1 : null))
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const restore = async (index: number) => {
    setRestoring(true)
    try {
      const res = await fetch(`/api/plugins/projects/${projectId}/history/${index}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Pin the snapshot the confirm dialog NAMED — if history shifted
        // underneath (agent edit, cap trim) the server 409s instead of
        // silently restoring the wrong version.
        body: JSON.stringify({ expectedTs: history?.[index]?.ts }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast(body.error ?? `restore failed (${res.status})`, 'error')
        if (res.status === 409) await load()
        return
      }
      const body = (await res.json().catch(() => ({}))) as { changed?: boolean }
      if (body.changed === false) toast('Plan already matches that version', 'info')
      setConfirmRestore(null)
      onRestored()
      await load()
    } finally {
      setRestoring(false)
    }
  }

  const snapshot = selected !== null ? history?.[selected] : undefined

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

  if (history === null) {
    return <SystemState kind="loading" scope="page" headingLevel={3} title="Loading history" />
  }
  if (history.length === 0) {
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
      <div className="flex flex-wrap items-end gap-bakin-3">
        <Field name="compareWith">
          <FieldLabel htmlFor="plan-history-picker">Compare current with</FieldLabel>
          <Select
            data-testid="plan-history-picker"
            value={String(selected ?? '')}
            onValueChange={(value: string) => setSelected(Number(value))}
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
            size="xs"
            data-testid="plan-history-restore"
            onClick={() => setConfirmRestore(selected)}
          >
            Restore this version
          </Button>
        )}
        <Text size="meta" tone="muted">{changed === 0 ? 'No changes' : `${changed} changed ${changed === 1 ? 'line' : 'lines'}`}</Text>
      </div>

      <div data-testid="plan-history-diff" className="max-h-96 overflow-auto rounded-bakin-surface border border-bakin-border-subtle bg-bakin-surface-default/60 font-bakin-typography-family-mono text-bakin-typography-size-meta leading-5">
        {diffResult.tooLarge && (
          <Text as="p" size="meta" tone="muted" className="px-bakin-3 py-bakin-2">Diff too large to render inline (over {DIFF_LINE_LIMIT.toLocaleString()} lines) — restore still works.</Text>
        )}
        {diff.map((line, i) => (
          <div
            key={i}
            data-diff-type={line.type}
            className={
              line.type === 'added'
                ? 'bg-bakin-signal-success/10 px-bakin-3 text-bakin-signal-success'
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
        open={confirmRestore !== null && !!history[confirmRestore]}
        title="Restore this plan version?"
        description={confirmRestore !== null && history[confirmRestore]
          ? `The plan body returns to ${snapshotLabel(history[confirmRestore])}. Your current version is kept as a new snapshot, so nothing is lost.`
          : ''}
        confirmLabel="Restore"
        busyLabel="Restoring…"
        busy={restoring}
        confirmTestId="plan-history-restore-confirm"
        onConfirm={() => { if (confirmRestore !== null) void restore(confirmRestore) }}
        onCancel={() => { if (!restoring) setConfirmRestore(null) }}
      />
    </div>
  )
}
