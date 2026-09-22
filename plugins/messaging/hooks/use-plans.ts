'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Plan } from '../types'
import { useMessagingContentRefresh } from './use-messaging-refresh'

const PLAN_REFRESH_PREFIXES = ['messaging/plans/']

interface UsePlansOptions {
  status?: string
  agent?: string
  campaign?: string
}

interface UsePlansResult {
  plans: Plan[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  removePlan: (id: string) => void
}

function plansUrl(options: UsePlansOptions): string {
  const params = new URLSearchParams()
  if (options.status) params.set('status', options.status)
  if (options.agent) params.set('agent', options.agent)
  if (options.campaign) params.set('campaign', options.campaign)
  const qs = params.toString()
  return qs ? `/api/plugins/messaging/plans?${qs}` : '/api/plugins/messaging/plans'
}

export function usePlans(options: UsePlansOptions = {}): UsePlansResult {
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const optionsKey = useMemo(
    () => JSON.stringify({
      status: options.status ?? '',
      agent: options.agent ?? '',
      campaign: options.campaign ?? '',
    }),
    [options.agent, options.campaign, options.status],
  )

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current
    setLoading(true)
    setError(null)
    try {
      const parsed = JSON.parse(optionsKey) as UsePlansOptions
      const response = await fetch(plansUrl(parsed))
      if (!response.ok) throw new Error(`Failed to load Plans (${response.status})`)
      const data = await response.json() as { plans?: Plan[] }
      if (version === requestVersion.current) setPlans(Array.isArray(data.plans) ? data.plans : [])
    } catch (err) {
      if (version === requestVersion.current) {
        setError(err instanceof Error ? err.message : String(err))
        setPlans([])
      }
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [optionsKey])

  const refreshFromEvent = useCallback(() => { void refresh() }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useMessagingContentRefresh(refreshFromEvent, PLAN_REFRESH_PREFIXES)

  const removePlan = useCallback((id: string) => {
    // A refresh begun before successful deletion must not restore its old row.
    requestVersion.current += 1
    setPlans(current => current.filter(plan => plan.id !== id))
    setLoading(false)
  }, [])

  return { plans, loading, error, refresh, removePlan }
}
