'use client'

/**
 * RenderedPlan — the read-only Details view with a subtle "what just
 * changed" hint (bakin#703): blocks the latest edit touched carry a thin
 * accent bar + faint tint, so a small edit in a long plan is scannable
 * without rereading everything. Baseline is the newest history snapshot
 * (the same default the Diff view compares against); the exact line-level
 * review lives in the Diff toggle.
 */
import { useEffect, useState } from 'react'
import { MarkdownEditor } from '@makinbakin/sdk/components'
import type { PlanSnapshot } from '../types'
import { markChangedBlocks } from '../lib/block-diff'

export function RenderedPlan({ projectId, body }: { projectId: string; body: string }) {
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

  const blocks = previousBody !== null ? markChangedBlocks(previousBody, body) : null
  if (!blocks || !blocks.some((block) => block.changed)) {
    return <MarkdownEditor content={body} editing={false} onChange={() => {}} placeholder="Project details, goals, background..." format="markdown" />
  }

  return (
    <div data-testid="rendered-plan" className="space-y-3">
      {blocks.map((block, index) => (
        <div
          key={index}
          {...(block.changed
            ? {
                'data-plan-changed-block': true,
                title: 'Changed in the latest edit',
                className: 'relative -ml-3 rounded-r-md border-l-2 border-[#5e6ad2]/60 bg-[#5e6ad2]/[0.06] pl-3 py-0.5',
              }
            : {})}
        >
          <MarkdownEditor content={block.text} editing={false} onChange={() => {}} format="markdown" />
        </div>
      ))}
    </div>
  )
}
