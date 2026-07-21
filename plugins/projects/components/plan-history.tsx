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
import type { PlanSnapshot } from '../types'
import { diffLines } from '../lib/line-diff'

function snapshotLabel(snapshot: PlanSnapshot): string {
  const when = new Date(snapshot.ts)
  const stamp = Number.isNaN(when.getTime())
    ? snapshot.ts
    : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${stamp} · ${snapshot.author === 'agent' ? 'agent edit' : 'your edit'}`
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
    return <p className="text-[12px] text-zinc-500">Loading history…</p>
  }
  if (history.length === 0) {
    return <p className="text-[12px] text-zinc-500">No plan versions yet — edits (yours or the agent's) snapshot the previous version here.</p>
  }


  return (
    <div data-testid="plan-history" className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-zinc-500">Compare current with</label>
        <select
          data-testid="plan-history-picker"
          className="bg-zinc-900 border border-[rgba(255,255,255,0.08)] rounded-md px-2 py-1 text-[12px] text-zinc-200"
          value={selected ?? ''}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {[...history.keys()].reverse().map((index) => (
            <option key={index} value={index}>
              {snapshotLabel(history[index])}{index === history.length - 1 ? ' (previous)' : ''}
            </option>
          ))}
        </select>
        {snapshot && (
          <button
            type="button"
            data-testid="plan-history-restore"
            onClick={() => setConfirmRestore(selected)}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-800 text-zinc-300 hover:text-foreground hover:bg-zinc-700 border border-[rgba(255,255,255,0.08)] transition-colors"
          >
            Restore this version
          </button>
        )}
        <span className="text-[11px] text-zinc-500">{changed === 0 ? 'No changes' : `${changed} changed ${changed === 1 ? 'line' : 'lines'}`}</span>
      </div>

      <div data-testid="plan-history-diff" className="rounded-lg border border-[rgba(255,255,255,0.06)] bg-zinc-950/60 overflow-auto max-h-[420px] font-mono text-[12px] leading-5">
        {diffResult.tooLarge && (
          <p className="px-3 py-2 text-zinc-500">Diff too large to render inline (over {DIFF_LINE_LIMIT.toLocaleString()} lines) — restore still works.</p>
        )}
        {diff.map((line, i) => (
          <div
            key={i}
            data-diff-type={line.type}
            className={
              line.type === 'added'
                ? 'px-3 bg-emerald-500/10 text-emerald-300'
                : line.type === 'removed'
                  ? 'px-3 bg-red-500/10 text-red-400 line-through decoration-red-500/40'
                  : 'px-3 text-zinc-500'
            }
          >
            <span className="select-none mr-2 opacity-60">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span>
            {line.text || ' '}
          </div>
        ))}
      </div>

      {confirmRestore !== null && history[confirmRestore] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => !restoring && setConfirmRestore(null)} />
          <div className="relative bg-zinc-900 border border-[rgba(255,255,255,0.08)] rounded-xl shadow-2xl w-[420px] p-6">
            <h3 className="text-sm font-semibold text-foreground mb-2">Restore this plan version?</h3>
            <p className="text-[12px] text-zinc-400 mb-4">
              The plan body returns to <span className="text-zinc-200 font-medium">{snapshotLabel(history[confirmRestore])}</span>.
              Your current version is kept as a new snapshot, so nothing is lost.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRestore(null)}
                disabled={restoring}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                data-testid="plan-history-restore-confirm"
                onClick={() => void restore(confirmRestore)}
                disabled={restoring}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 transition-colors disabled:opacity-50"
              >
                {restoring ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
