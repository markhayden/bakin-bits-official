'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Deliverable, Plan } from '../types'
import { useMessagingContentRefresh } from './use-messaging-refresh'

const PLAN_DETAIL_REFRESH_PREFIXES = ['messaging/plans/', 'messaging/deliverables/']

interface UsePlanResult {
  plan: Plan | null
  deliverables: Deliverable[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function usePlan(planId: string | undefined): UsePlanResult {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [deliverables, setDeliverables] = useState<Deliverable[]>([])
  const [loading, setLoading] = useState(Boolean(planId))
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!planId) {
      setPlan(null)
      setDeliverables([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const encoded = encodeURIComponent(planId)
      const response = await fetch(`/api/plugins/messaging/plans/${encoded}?id=${encoded}`)
      if (!response.ok) throw new Error(`Failed to load Plan (${response.status})`)
      const data = await response.json() as { plan?: Plan; deliverables?: Deliverable[] }
      setPlan(data.plan ?? null)
      setDeliverables(Array.isArray(data.deliverables) ? data.deliverables : [])
    } catch (err) {
      setPlan(null)
      setDeliverables([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [planId])

  const refreshFromEvent = useCallback(() => { void refresh() }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useMessagingContentRefresh(refreshFromEvent, PLAN_DETAIL_REFRESH_PREFIXES)

  return { plan, deliverables, loading, error, refresh }
}
