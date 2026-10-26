'use client'

import { useRef, type ReactNode } from 'react'
import { Ellipsis, Trash } from 'lucide-react'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Text } from '@makinbakin/sdk/ui'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { ListRow, ListRowActions, StatusBadge, StatusMarker } from '@makinbakin/sdk/patterns'
import { formatAge } from '@makinbakin/sdk/utils'
import { ProjectStatusBadge } from './project-status-badge'
import type { ProjectSummary } from '../types'

type Tone = 'neutral' | 'accent' | 'attention'

/**
 * The ONE resume signal a row shows (D18, D29), by priority: a sign-off is
 * yours to decide › the lead is waiting on you › the lead is working › a new
 * reply › work is stuck › the plan changed › today's check-ins are used up ›
 * progress.
 */
export function resumeSignal(project: ProjectSummary, leadName: string): { text: string; tone: Tone; pulse?: boolean } {
  if (project.needsApproval) return { text: 'Needs approval', tone: 'attention' }
  if (project.waitingForYou) return { text: 'Waiting for you', tone: 'attention' }
  if (project.brainstormStreaming) return { text: `${leadName} is working`, tone: 'accent', pulse: true }
  if (project.brainstormUnread) return { text: `New reply from ${leadName}`, tone: 'attention' }
  if (project.stuck) return { text: 'Stuck', tone: 'attention' }
  if (project.planUpdated) return { text: 'Plan updated', tone: 'accent' }
  if (project.checkinsPausedToday) return { text: 'Check-ins paused for today', tone: 'neutral' }
  if (!project.taskCount) return { text: 'No steps yet', tone: 'neutral' }
  return { text: `${project.doneCount ?? 0} of ${project.taskCount} steps done`, tone: 'neutral' }
}

export function ProjectRow({ project, leadName, onClick, onDelete, scoreOverlay }: {
  project: ProjectSummary
  /** The lead agent's display name. */
  leadName: string
  onClick: () => void
  onDelete: (trigger: HTMLButtonElement | null) => void
  scoreOverlay?: ReactNode
}) {
  const title = project.title || 'Untitled project'
  const actionsRef = useRef<HTMLButtonElement>(null)
  const signal = resumeSignal(project, leadName)
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
            <ProjectStatusBadge status={project.status} />
            {project.status === 'active' && project.stewardPaused ? (
              <StatusBadge tone="neutral" variant="outline" size="xs">Paused</StatusBadge>
            ) : null}
            <ListRowActions>
              <DropdownMenu>
                <DropdownMenuTrigger ref={actionsRef} render={<Button size="icon-xs" variant="ghost" />} aria-label={`More actions for ${title}`}>
                  <Ellipsis aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="danger" onClick={() => onDelete(actionsRef.current)}>
                    <Trash aria-hidden="true" />
                    Delete project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ListRowActions>
          </Inline>
        </Inline>
        <Inline gap="item">
          <Inline gap="dense" wrap={false} data-resume-signal="">
            {signal.tone !== 'neutral' ? (
              <StatusMarker tone={signal.tone} className={signal.pulse ? 'animate-pulse motion-reduce:animate-none' : undefined} />
            ) : null}
            <Text size="meta" tone={signal.tone === 'neutral' ? 'muted' : 'default'}>{signal.text}</Text>
          </Inline>
          <Text size="meta" tone="muted">Updated {formatAge(project.updated)}</Text>
        </Inline>
        {scoreOverlay}
      </Stack>
    </ListRow>
  )
}
