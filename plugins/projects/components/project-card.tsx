'use client'

import { Progress } from '@makinbakin/sdk/ui'
import { ProjectStatusBadge } from './project-status-badge'
import type { ProjectSummary } from '../types'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ProjectCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-lg border border-border bg-card p-bakin-4 text-left transition-colors hover:bg-bakin-surface-elevated"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-medium text-foreground">
          {project.title || 'Untitled project'}
        </h3>
        <ProjectStatusBadge status={project.status} />
      </div>

      <Progress value={project.progress} aria-label={`${project.title || 'Untitled project'} progress`} />

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{project.progress}% complete</span>
        <span>{project.taskCount} items</span>
      </div>

      <div className="mt-1 text-[11px] text-muted-foreground">
        Updated {formatDate(project.updated)}
      </div>
    </button>
  )
}
