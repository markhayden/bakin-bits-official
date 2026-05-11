'use client'

import { Badge } from "@bakin/sdk/ui"
import type { DeliverableStatus } from '../types'
import { DELIVERABLE_STATUS_BADGE } from '../constants'

interface DeliverableStatusBadgeProps {
  status: DeliverableStatus
  className?: string
}

function formatStatus(status: DeliverableStatus): string {
  return status.replaceAll('_', ' ')
}

export function DeliverableStatusBadge({ status, className = '' }: DeliverableStatusBadgeProps) {
  return (
    <Badge className={`capitalize ${DELIVERABLE_STATUS_BADGE[status]} ${className}`}>
      {formatStatus(status)}
    </Badge>
  )
}
