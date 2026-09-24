'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMessagingContentRefresh } from './use-messaging-refresh'

const PLAN_REFRESH_PREFIXES = ['messaging/plans/']

export interface PlansSummary {
  needsReview: number
  total: number
}

interface UsePlansSummaryResult {
  summary: PlansSummary | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Cheap counts for the Plans nav badge. Hits the dedicated
 * `/plans/summary` endpoint (numbers only, no Plan bodies) and refreshes
 * on the same SSE file events that drive the Plans list, so the badge
 * stays current without any cron/heartbeat/MCP traffic.
 */
export function usePlansSummary(): UsePlansSummaryResult {
  const [summary, setSummary] = useState<PlansSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const generation = useRef(0)
  const active = useRef<AbortController | null>(null)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempts = useRef(0)
  const refresh = useCallback(async function refresh() {
    const seq = ++generation.current
    active.current?.abort()
    if (retry.current) clearTimeout(retry.current)
    const controller = new AbortController()
    active.current = controller
    const deadline = setTimeout(() => controller.abort(), 15_000)
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/plugins/messaging/plans/summary', { signal: controller.signal })
      if (!response.ok) throw new Error(`Failed to load Plans summary (${response.status})`)
      const data = await response.json() as Partial<PlansSummary>
      if (!Number.isSafeInteger(data.needsReview) || !Number.isSafeInteger(data.total)
        || data.needsReview! < 0 || data.total! < 0) throw new Error('Invalid Plans summary')
      if (seq !== generation.current) return
      attempts.current = 0
      setSummary({
        needsReview: data.needsReview!,
        total: data.total!,
      })
    } catch (err) {
      if (seq !== generation.current) return
      setError(err instanceof Error ? err.message : String(err))
      retry.current = setTimeout(() => { void refresh() }, Math.min(1000 * 2 ** attempts.current++, 30_000))
    } finally {
      clearTimeout(deadline)
      if (seq === generation.current) setLoading(false)
    }
  }, [])

  const refreshFromEvent = useCallback(() => { void refresh() }, [refresh])

  useMessagingContentRefresh(refreshFromEvent, PLAN_REFRESH_PREFIXES)
  useEffect(() => {
    void refresh()
    return () => {
      // Invalidate outstanding responses on unmount.
      generation.current++
      active.current?.abort()
      if (retry.current) clearTimeout(retry.current)
    }
  }, [refresh])

  return { summary, loading, error, refresh }
}
