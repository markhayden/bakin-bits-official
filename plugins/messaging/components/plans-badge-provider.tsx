'use client'

import type { NavBadge } from '@makinbakin/sdk'
import { useNavBadge } from '@makinbakin/sdk/hooks'
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

  const badge: NavBadge | null = summary && summary.needsReview > 0
    ? { count: summary.needsReview, tone: 'attention' }
    : null

  useNavBadge('messaging', 'messaging-plans', badge)

  return null
}
