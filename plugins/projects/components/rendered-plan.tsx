'use client'

/**
 * RenderedPlan — the read-only Details view with a subtle "what just
 * changed" hint (bakin#703): a solid green bar along the left edge of
 * blocks the latest edit added or changed, and a short red tick where
 * content was removed — so a small edit in a long plan is scannable
 * without rereading everything. Baseline is the newest history snapshot
 * (the same default the Diff view compares against); the exact
 * line-level review lives in the Diff toggle.
 */
import { useEffect, useMemo, useState } from 'react'
import { MarkdownEditor } from '@makinbakin/sdk/content'
import { Tooltip, TooltipContent, TooltipTrigger } from '@makinbakin/sdk/ui'
import type { PlanSnapshot } from '../types'
import { diffBlocks } from '../lib/block-diff'

const CHANGED_BLOCK_HINT = 'Added or edited in the latest edit'

export function RenderedPlan({ projectId, body, hintsEnabled = true }: { projectId: string; body: string; hintsEnabled?: boolean }) {
  // null = no baseline (no history yet, or still loading) → plain render.
  const [previousBody, setPreviousBody] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    const load = async () => {
      const res = await fetch(`/api/plugins/projects/${projectId}/history`)
      if (!res.ok) return
      const data = (await res.json()) as { history?: PlanSnapshot[] }
      const last = Array.isArray(data.history) ? data.history[data.history.length - 1] : undefined
      if (!cancelled) setPreviousBody(last ? last.body : null)
    }
    void load()
    return () => {
      cancelled = true
    }
    // body is a dependency on purpose: a new edit writes a new snapshot, and
    // the baseline must follow it so only the LATEST change stays marked.
  }, [projectId, body])

  // Memoized: the detail page re-renders per streamed chunk.
  const entries = useMemo(
    () => (hintsEnabled && previousBody !== null ? diffBlocks(previousBody, body) : null),
    [hintsEnabled, previousBody, body],
  )
  const hasChanges = entries?.some((entry) => entry.type === 'removed' || (entry.type === 'block' && entry.changed))
  if (!entries || !hasChanges) {
    return <MarkdownEditor content={body} editing={false} onChange={() => {}} placeholder="Project details, goals, background..." format="markdown" />
  }

  return (
    <div data-testid="rendered-plan" className="space-y-bakin-3">
      {entries.map((entry, index) =>
        entry.type === 'removed' ? (
          // Deleted content has no block to mark — a solid red tick shows
          // where it used to be.
          <div
            key={index}
            data-plan-removed-marker
            className="h-bakin-1 w-12 rounded-bakin-pill bg-bakin-signal-danger"
          >
            <span className="sr-only">Content removed here in the latest edit</span>
          </div>
        ) : entry.changed ? (
          // The hint rides a kit Tooltip on hover plus an sr-only label, so
          // the meaning reaches pointer AND assistive-tech readers (a bare
          // `title` on a non-interactive block reached neither reliably).
          <Tooltip key={index}>
            <TooltipTrigger
              render={(
                <div
                  data-plan-changed-block
                  className="rounded-r-bakin-control border-l-2 border-bakin-signal-success bg-bakin-signal-success/10 py-bakin-1 pl-bakin-3"
                />
              )}
            >
              <span className="sr-only">{CHANGED_BLOCK_HINT}</span>
              <MarkdownEditor content={entry.text} editing={false} onChange={() => {}} format="markdown" />
            </TooltipTrigger>
            <TooltipContent>{CHANGED_BLOCK_HINT}</TooltipContent>
          </Tooltip>
        ) : (
          // Every block carries the same gutter so text stays aligned; the
          // bar is in normal flow (a negative margin put it outside the
          // scroll container's clip — invisible).
          <div key={index} className="border-l-2 border-transparent pl-bakin-3">
            <MarkdownEditor content={entry.text} editing={false} onChange={() => {}} format="markdown" />
          </div>
        ),
      )}
    </div>
  )
}
