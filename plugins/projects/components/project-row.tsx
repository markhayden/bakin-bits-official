'use client'

import type { ReactNode } from 'react'
import { Progress, Text } from '@makinbakin/sdk/ui'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { ListRow, StatusMarker } from '@makinbakin/sdk/patterns'
import { formatAge } from '@makinbakin/sdk/utils'
import { ProjectStatusBadge } from './project-status-badge'
import type { ProjectSummary } from '../types'

export function ProjectRow({ project, onClick, scoreOverlay }: {
  project: ProjectSummary
  onClick: () => void
  scoreOverlay?: ReactNode
}) {
  const title = project.title || 'Untitled project'
  return (
    <ListRow
      interactive={{ label: `Open project: ${title}`, onActivate: onClick }}
    >
      <Stack gap="dense">
        <Inline align="start" justify="between" gap="dense" wrap={false}>
          <Text weight="semibold" className="min-w-0 break-words">
            {title}
          </Text>
          <Inline gap="dense" wrap={false} className="shrink-0">
            {project.brainstormStreaming ? (
              <StatusMarker tone="accent" label="Brainstorm reply in progress" className="animate-pulse motion-reduce:animate-none" />
            ) : project.brainstormUnread ? (
              <StatusMarker tone="attention" label="Unseen brainstorm reply" />
            ) : null}
            <ProjectStatusBadge status={project.status} />
          </Inline>
        </Inline>
        <Inline gap="item">
          <Text size="meta" tone="muted">{project.taskCount} items</Text>
          <Inline gap="dense" wrap={false}>
            <Progress value={project.progress} aria-label={`${title} progress`} className="w-[calc(var(--bakin-layout-space-8)*3)]" />
            <Text size="meta" tone="muted">{project.progress}% complete</Text>
          </Inline>
          <Text size="meta" tone="muted">Updated {formatAge(project.updated)}</Text>
        </Inline>
        {scoreOverlay}
      </Stack>
    </ListRow>
  )
}
