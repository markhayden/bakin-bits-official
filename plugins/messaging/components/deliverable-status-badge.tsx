'use client'

import { StatusBadge } from "@makinbakin/sdk/patterns"
import type { DeliverableStatus } from '../types'
import { DELIVERABLE_STATUS_TONE } from '../constants'
import { cn } from '@makinbakin/sdk/utils'

interface DeliverableStatusBadgeProps {
  status: DeliverableStatus
  className?: string
}

function formatStatus(status: DeliverableStatus): string {
  return status.replaceAll('_', ' ')
}

export function DeliverableStatusBadge({ status, className = '' }: DeliverableStatusBadgeProps) {
  return (
    <StatusBadge size="xs" tone={DELIVERABLE_STATUS_TONE[status]} className={cn('capitalize', className)}>
      {formatStatus(status)}
    </StatusBadge>
  )
}
