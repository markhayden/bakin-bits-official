'use client'

import { useRef, useState } from 'react'
import { ConfirmDialog } from '@makinbakin/sdk/patterns'
import type { Plan } from '../types'

/** Shared destructive flow for the Plans index and individual plan workspace. */
export function PlanDeleteDialog({ plan, onClose, onDeleted, finalFocus }: {
  plan: Pick<Plan, 'id' | 'title'>
  onClose: () => void
  onDeleted?: () => void
  finalFocus?: () => HTMLElement | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const confirm = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    try {
      const id = encodeURIComponent(plan.id)
      const response = await fetch(`/api/plugins/messaging/plans/${id}?id=${id}&deleteLinkedTasks=true`, {
        method: 'DELETE', signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null
        throw new Error(typeof body?.error === 'string' && body.error.trim() ? body.error : 'Could not delete this plan.')
      }
      onDeleted?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.name === 'AbortError'
        ? 'Plan delete timed out. Cleanup may still be running; refresh the Plans list in a moment.'
        : err instanceof Error ? err.message : String(err))
    } finally {
      window.clearTimeout(timeout)
      inFlight.current = false
      setBusy(false)
    }
  }

  return <ConfirmDialog
    open
    title="Delete this plan?"
    description={`This removes “${plan.title || 'Untitled plan'}”, its content pieces, and any linked board tasks created for this plan.`}
    confirmLabel="Delete plan"
    busyLabel="Deleting..."
    confirmTone="danger"
    busy={busy}
    error={error}
    finalFocus={finalFocus}
    onConfirm={() => { void confirm() }}
    onCancel={() => { if (!inFlight.current) onClose() }}
  />
}
