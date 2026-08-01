'use client'

import { Button, Progress } from '@makinbakin/sdk/ui'
import { ProjectStatusBadge } from './project-status-badge'
import type { ProjectSummary } from '../types'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ProjectCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      className="!h-auto w-full flex-col items-stretch justify-start gap-0 whitespace-normal rounded-lg border-bakin-border-subtle/30 bg-bakin-surface-default p-bakin-4 text-left font-bakin-typography-weight-regular transition-colors hover:border-bakin-border-subtle/30 hover:bg-bakin-surface-elevated"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-medium text-bakin-text-primary">
          {project.title || 'Untitled project'}
        </h3>
        <div className="flex shrink-0 items-center gap-bakin-2">
          {project.brainstormStreaming ? (
            <span data-testid="card-brainstorm-streaming" title="Brainstorm reply in progress" className="size-bakin-2 animate-pulse rounded-bakin-pill bg-bakin-signal-info" />
          ) : project.brainstormUnread ? (
            <span data-testid="card-brainstorm-unread" title="Unseen brainstorm reply" className="size-bakin-2 rounded-bakin-pill bg-bakin-signal-attention" />
          ) : null}
          <ProjectStatusBadge status={project.status} />
        </div>
      </div>

      <Progress value={project.progress} aria-label={`${project.title || 'Untitled project'} progress`} />

      <div className="mt-3 flex items-center justify-between text-bakin-typography-size-meta text-bakin-text-muted">
        <span>{project.progress}% complete</span>
        <span>{project.taskCount} items</span>
      </div>

      <div className="mt-1 text-bakin-typography-size-meta text-bakin-text-muted">
        Updated {formatDate(project.updated)}
      </div>
    </Button>
  )
}
