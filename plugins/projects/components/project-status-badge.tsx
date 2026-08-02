'use client'

import { StatusBadge } from '@makinbakin/sdk/patterns'
import type { ProjectStatus } from '../types'

type StatusTone = 'neutral' | 'success' | 'attention' | 'danger' | 'accent'

const STATUS_META: Record<ProjectStatus, { tone: StatusTone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  active: { tone: 'accent', label: 'Active' },
  completed: { tone: 'success', label: 'Completed' },
  archived: { tone: 'neutral', label: 'Archived' },
}

export function ProjectStatusBadge({ status, onClick }: { status: ProjectStatus; onClick?: () => void }) {
  const meta = STATUS_META[status] || STATUS_META.draft
  return (
    <StatusBadge
      tone={meta.tone}
      variant="soft"
      size="xs"
      onClick={onClick}
      className={onClick ? 'cursor-pointer' : undefined}
    >
      {meta.label}
    </StatusBadge>
  )
}
