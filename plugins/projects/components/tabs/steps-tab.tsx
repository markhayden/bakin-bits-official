'use client'

/** Steps tab (D16): the project's checklist. */
import type { ChecklistModel } from '../../hooks/use-checklist-drafts'
import type { ProjectDetailData } from '../../types'
import { ProjectChecklist } from '../project-checklist'

export function StepsTab({ project, checklist }: { project: ProjectDetailData; checklist: ChecklistModel }) {
  return <ProjectChecklist projectId={project.id} tasks={project.tasks} resolvedTasks={project.resolvedTasks} model={checklist} />
}
