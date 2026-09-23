import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectDetailData, ProjectEditableValues } from '../types'
import { ProjectApiError, projectRequest } from '../lib/project-api'
import { acceptDraft, createDraft, draftDirty, editDraft, prepareDraft, projectFields, refreshDraft, resolveDraft } from '../lib/project-draft'
import type { ProjectDraft, ProjectField } from '../lib/project-draft'

const empty: ProjectEditableValues = { title: '', owner: '', status: 'draft', body: '' }
export function useProjectDraft(projectId: string, project: ProjectDetailData | null, refresh: () => Promise<ProjectDetailData | null>) {
  const [draft, setDraft] = useState(() => createDraft(project ?? empty))
  const current = useRef(draft)
  const owner = useRef(projectId)
  owner.current = projectId
  const initialized = useRef<string | null>(null)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = useCallback((next: ProjectDraft) => { current.current = next; setDraft(next) }, [])
  useEffect(() => {
    if (!project || project.id !== projectId) return
    update(initialized.current === projectId ? refreshDraft(current.current, project) : createDraft(project))
    initialized.current = projectId
  }, [project, projectId, update])

  const save = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false
    let submitted
    try { submitted = prepareDraft(current.current) } catch (error) {
      setError(error instanceof Error ? error.message : 'Review the project fields.'); return false
    }
    if (!Object.keys(submitted.patch).length) return true
    busy.current = true; setSaving(true); setError(null)
    try {
      await projectRequest(encodeURIComponent(projectId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submitted.patch, expected: submitted.expected }),
      })
      if (owner.current !== projectId) return false
      update(acceptDraft(current.current, submitted))
      const latest = await refresh()
      if (owner.current !== projectId) return false
      if (latest) update(refreshDraft(current.current, latest))
      return !draftDirty(current.current)
    } catch (failure) {
      if (owner.current !== projectId) return false
      if (failure instanceof ProjectApiError && failure.status === 409) {
        const payload = failure.detail as { conflicts?: Record<string, { current?: unknown }> } | undefined
        const latest = { ...current.current.latest }
        for (const field of projectFields) {
          const value = payload?.conflicts?.[field]?.current
          if (typeof value === 'string' && (field !== 'status' || ['draft', 'active', 'completed', 'archived'].includes(value))) Object.assign(latest, { [field]: value })
        }
        update(refreshDraft(current.current, latest))
      }
      setError(failure instanceof Error ? failure.message : 'Project could not be saved. Try again.')
      return false
    } finally {
      busy.current = false
      if (owner.current === projectId) setSaving(false)
    }
  }, [projectId, refresh, update])
  return {
    draft, saving, error, dirty: draftDirty(draft), save,
    validate: () => { try { prepareDraft(current.current); return true } catch (error) { setError((error as Error).message); return false } },
    isDirty: () => draftDirty(current.current),
    edit: <K extends ProjectField>(field: K, value: ProjectEditableValues[K]) => { update(editDraft(current.current, field, value)); setError(null) },
    resolve: (field: ProjectField, choice: 'mine' | 'latest') => { update(resolveDraft(current.current, field, choice)); setError(null) },
    discard: () => { if (!busy.current) { update(createDraft(current.current.latest)); setError(null) } },
  }
}
