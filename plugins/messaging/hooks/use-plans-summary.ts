'use client'

import { useCallback, useEffect, useState } from 'react'
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

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/plugins/messaging/plans/summary')
      if (!response.ok) throw new Error(`Failed to load Plans summary (${response.status})`)
      const data = await response.json() as Partial<PlansSummary>
      setSummary({
        needsReview: typeof data.needsReview === 'number' ? data.needsReview : 0,
        total: typeof data.total === 'number' ? data.total : 0,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshFromEvent = useCallback(() => { void refresh() }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useMessagingContentRefresh(refreshFromEvent, PLAN_REFRESH_PREFIXES)

  return { summary, loading, error, refresh }
}
