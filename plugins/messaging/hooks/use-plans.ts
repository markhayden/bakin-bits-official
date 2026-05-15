'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const optionsKey = useMemo(
    () => JSON.stringify({
      status: options.status ?? '',
      agent: options.agent ?? '',
      campaign: options.campaign ?? '',
    }),
    [options.agent, options.campaign, options.status],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const parsed = JSON.parse(optionsKey) as UsePlansOptions
      const response = await fetch(plansUrl(parsed))
      if (!response.ok) throw new Error(`Failed to load Plans (${response.status})`)
      const data = await response.json() as { plans?: Plan[] }
      setPlans(Array.isArray(data.plans) ? data.plans : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPlans([])
    } finally {
      setLoading(false)
    }
  }, [optionsKey])

  const refreshFromEvent = useCallback(() => { void refresh() }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useMessagingContentRefresh(refreshFromEvent, PLAN_REFRESH_PREFIXES)

  return { plans, loading, error, refresh }
}
