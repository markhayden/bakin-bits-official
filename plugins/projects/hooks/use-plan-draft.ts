import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectDetailData } from '../types'
import { ProjectApiError, projectRequest } from '../lib/project-api'
import {
  acceptPlanDraft,
  createPlanDraft,
  editPlanDraft,
  planDraftDirty,
  preparePlanDraft,
  refreshPlanDraft,
  resolvePlanDraft,
  type PlanDraft,
} from '../lib/plan-draft'

/** Page-level plan draft: survives tab switches; one expected-value save. */
export function usePlanDraft(projectId: string, project: ProjectDetailData | null, refresh: () => Promise<ProjectDetailData | null>) {
  const [draft, setDraft] = useState(() => createPlanDraft(project?.body ?? ''))
  const current = useRef(draft)
  const owner = useRef(projectId)
  owner.current = projectId
  const initialized = useRef<string | null>(null)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = useCallback((next: PlanDraft) => { current.current = next; setDraft(next) }, [])
  useEffect(() => {
    if (!project || project.id !== projectId) return
    update(initialized.current === projectId ? refreshPlanDraft(current.current, project.body) : createPlanDraft(project.body))
    initialized.current = projectId
  }, [project, projectId, update])

  const save = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false
    let submitted
    try { submitted = preparePlanDraft(current.current) } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Review the plan before saving.'); return false
    }
    if (submitted.body === submitted.expected) return true
    busy.current = true; setSaving(true); setError(null)
    try {
      await projectRequest(encodeURIComponent(projectId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: submitted.body, expected: { body: submitted.expected } }),
      })
      if (owner.current !== projectId) return false
      update(acceptPlanDraft(current.current, submitted))
      const latest = await refresh()
      if (owner.current !== projectId) return false
      if (latest) update(refreshPlanDraft(current.current, latest.body))
      return !planDraftDirty(current.current)
    } catch (failure) {
      if (owner.current !== projectId) return false
      if (failure instanceof ProjectApiError && failure.status === 409) {
        const payload = failure.detail as { conflicts?: { body?: { current?: unknown } } } | undefined
        const latest = payload?.conflicts?.body?.current
        if (typeof latest === 'string') update(refreshPlanDraft(current.current, latest))
      }
      setError(failure instanceof Error ? failure.message : 'The plan could not be saved. Try again.')
      return false
    } finally {
      busy.current = false
      if (owner.current === projectId) setSaving(false)
    }
  }, [projectId, refresh, update])

  return {
    draft, saving, error, dirty: planDraftDirty(draft), save,
    validate: () => { try { preparePlanDraft(current.current); return true } catch (failure) { setError((failure as Error).message); return false } },
    isDirty: () => planDraftDirty(current.current),
    edit: (value: string) => { update(editPlanDraft(current.current, value)); setError(null) },
    resolve: (choice: 'mine' | 'latest') => { update(resolvePlanDraft(current.current, choice)); setError(null) },
    discard: () => { if (!busy.current) { update(createPlanDraft(current.current.latest)); setError(null) } },
  }
}
export type PlanDraftModel = ReturnType<typeof usePlanDraft>
