'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Deliverable } from '../types'
import { useMessagingContentRefresh } from './use-messaging-refresh'

const DELIVERABLE_REFRESH_PREFIXES = ['messaging/deliverables/']

interface UseDeliverablesOptions {
  planId?: string | null
  status?: string
  channel?: string
  publishAfter?: string
  publishBefore?: string
}

interface UseDeliverablesResult {
  deliverables: Deliverable[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

function deliverablesUrl(options: UseDeliverablesOptions): string {
  const params = new URLSearchParams()
  if (options.planId !== undefined) params.set('planId', options.planId === null ? 'null' : options.planId)
  if (options.status) params.set('status', options.status)
  if (options.channel) params.set('channel', options.channel)
  if (options.publishAfter) params.set('publishAfter', options.publishAfter)
  if (options.publishBefore) params.set('publishBefore', options.publishBefore)
  const qs = params.toString()
  return qs ? `/api/plugins/messaging/deliverables?${qs}` : '/api/plugins/messaging/deliverables'
}

export function useDeliverables(options: UseDeliverablesOptions = {}): UseDeliverablesResult {
  const [deliverables, setDeliverables] = useState<Deliverable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const optionsKey = useMemo(
    () => JSON.stringify({
      planId: options.planId === undefined ? undefined : options.planId,
      status: options.status ?? '',
      channel: options.channel ?? '',
      publishAfter: options.publishAfter ?? '',
      publishBefore: options.publishBefore ?? '',
    }),
    [options.channel, options.planId, options.publishAfter, options.publishBefore, options.status],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const parsed = JSON.parse(optionsKey) as UseDeliverablesOptions
      const response = await fetch(deliverablesUrl(parsed))
      if (!response.ok) throw new Error(`Failed to load Deliverables (${response.status})`)
      const data = await response.json() as { deliverables?: Deliverable[] }
      setDeliverables(Array.isArray(data.deliverables) ? data.deliverables : [])
    } catch (err) {
      setDeliverables([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [optionsKey])

  const refreshFromEvent = useCallback(() => { void refresh() }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useMessagingContentRefresh(refreshFromEvent, DELIVERABLE_REFRESH_PREFIXES)

  return { deliverables, loading, error, refresh }
}
