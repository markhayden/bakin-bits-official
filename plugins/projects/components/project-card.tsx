'use client'

import { Card, CardContent, CardFooter, CardHeader, CardTitle, Progress, Text } from '@makinbakin/sdk/ui'
import { Inline } from '@makinbakin/sdk/layout'
import { StatusMarker } from '@makinbakin/sdk/patterns'
import { formatAge } from '@makinbakin/sdk/utils'
import { ProjectStatusBadge } from './project-status-badge'
import type { ProjectSummary } from '../types'

export function ProjectCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const title = project.title || 'Untitled project'
  return (
    <Card
      size="sm"
      interactive={{ label: `Open project: ${title}`, onActivate: onClick }}
      className="h-full border-bakin-border-subtle/30"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-bakin-2">
          <CardTitle className="line-clamp-2">
            {title}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-bakin-2">
            {project.brainstormStreaming ? (
              <StatusMarker data-testid="card-brainstorm-streaming" tone="accent" label="Brainstorm reply in progress" className="animate-pulse motion-reduce:animate-none" />
            ) : project.brainstormUnread ? (
              <StatusMarker data-testid="card-brainstorm-unread" tone="attention" label="Unseen brainstorm reply" />
            ) : null}
            <ProjectStatusBadge status={project.status} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1">
        <Progress value={project.progress} aria-label={`${title} progress`} />
        <Inline justify="between" className="mt-bakin-3">
          <Text size="meta" tone="muted">{project.progress}% complete</Text>
          <Text size="meta" tone="muted">{project.taskCount} items</Text>
        </Inline>
      </CardContent>

      <CardFooter variant="meta">
        Updated {formatAge(project.updated)}
      </CardFooter>
    </Card>
  )
}
