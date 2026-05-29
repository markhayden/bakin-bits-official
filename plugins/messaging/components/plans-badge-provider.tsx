'use client'

import { useEffect } from 'react'
import { setNavBadge } from '@makinbakin/sdk'
import { usePlansSummary } from '../hooks/use-plans-summary'

/**
 * Background component (renders nothing) mounted via the host's
 * `nav-badge-providers` slot. It keeps the Plans nav item's badge in sync
 * with the number of Plans in `needs_review`: a count when positive,
 * cleared at zero (bakin #265). Source of truth is the Plan records —
 * no cron, heartbeat, or MCP traffic involved.
 */
export function PlansBadgeProvider() {
  const { summary } = usePlansSummary()

  useEffect(() => {
    if (!summary) return
    const badge = summary.needsReview > 0
      ? { count: summary.needsReview, tone: 'attention' as const }
      : null
    setNavBadge('messaging', 'messaging-plans', badge)
  }, [summary])

  return null
}
