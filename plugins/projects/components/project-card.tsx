'use client'

import { Card, CardContent, CardFooter, CardHeader, CardTitle, Progress } from '@makinbakin/sdk/ui'
import { ProjectStatusBadge } from './project-status-badge'
import type { ProjectSummary } from '../types'
import { StatusMarker } from '@makinbakin/sdk/patterns'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ProjectCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  return (
    <Card
      size="sm"
      interactive={{ label: `Open project: ${project.title || 'Untitled project'}`, onActivate: onClick }}
      className="h-full border-bakin-border-subtle/30"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-bakin-2">
          <CardTitle className="line-clamp-2">
            {project.title || 'Untitled project'}
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
        <Progress value={project.progress} aria-label={`${project.title || 'Untitled project'} progress`} />
        <div className="mt-bakin-3 flex items-center justify-between text-bakin-typography-size-meta text-bakin-text-muted">
          <span>{project.progress}% complete</span>
          <span>{project.taskCount} items</span>
        </div>
      </CardContent>

      <CardFooter variant="meta">
        Updated {formatDate(project.updated)}
      </CardFooter>
    </Card>
  )
}
