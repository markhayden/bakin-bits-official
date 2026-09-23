import type { ProjectEditableValues, ProjectPatch } from '../types'

export const projectFields = ['title', 'owner', 'status', 'body'] as const
export type ProjectField = typeof projectFields[number]
export interface DraftConflict { baseline: string; latest: string; local: string }
export interface ProjectDraft {
  baseline: ProjectEditableValues
  values: ProjectEditableValues
  latest: ProjectEditableValues
  conflicts: Partial<Record<ProjectField, DraftConflict>>
}
export interface DraftSubmission { patch: ProjectPatch; expected: ProjectPatch; values: ProjectEditableValues }

export function createDraft(values: ProjectEditableValues): ProjectDraft {
  return { baseline: { ...values }, values: { ...values }, latest: { ...values }, conflicts: {} }
}
export function draftDirty(state: ProjectDraft): boolean {
  return projectFields.some(field => state.values[field] !== state.baseline[field])
}
export function refreshDraft(state: ProjectDraft, latest: ProjectEditableValues): ProjectDraft {
  const next = { baseline: { ...state.baseline }, values: { ...state.values }, latest: { ...latest }, conflicts: {} as ProjectDraft['conflicts'] }
  for (const field of projectFields) {
    const baseline = state.baseline[field], local = state.values[field], remote = latest[field]
    if (local === baseline || local === remote) {
      Object.assign(next.baseline, { [field]: remote })
      Object.assign(next.values, { [field]: remote })
    } else if (remote !== baseline) {
      next.conflicts[field] = { baseline, local, latest: remote }
    }
  }
  return next
}
export function editDraft<K extends ProjectField>(state: ProjectDraft, field: K, value: ProjectEditableValues[K]): ProjectDraft {
  return refreshDraft({ ...state, values: { ...state.values, [field]: value } }, state.latest)
}
export function resolveDraft(state: ProjectDraft, field: ProjectField, choice: 'mine' | 'latest'): ProjectDraft {
  const value = state.latest[field]
  return refreshDraft({
    ...state, baseline: { ...state.baseline, [field]: value },
    values: choice === 'latest' ? { ...state.values, [field]: value } : state.values,
  }, state.latest)
}
export function prepareDraft(state: ProjectDraft): DraftSubmission {
  if (!state.values.title.trim()) throw new Error('Title is required.')
  if (Object.keys(state.conflicts).length) throw new Error('Review overlapping changes before saving.')
  const patch: ProjectPatch = {}, expected: ProjectPatch = {}
  for (const field of projectFields) {
    if (state.values[field] !== state.baseline[field]) {
      Object.assign(patch, { [field]: field === 'title' ? state.values[field].trim() : state.values[field] })
      Object.assign(expected, { [field]: state.baseline[field] })
    }
  }
  return { patch, expected, values: { ...state.values } }
}
/** Only the submitted snapshot becomes clean; typing during a save remains dirty. */
export function acceptDraft(state: ProjectDraft, submitted: DraftSubmission): ProjectDraft {
  const next = { baseline: { ...state.baseline }, values: { ...state.values }, latest: { ...state.latest }, conflicts: { ...state.conflicts } }
  for (const field of projectFields) {
    const value = submitted.patch[field]
    if (value === undefined) continue
    Object.assign(next.baseline, { [field]: value })
    Object.assign(next.latest, { [field]: value })
    if (next.values[field] === submitted.values[field]) Object.assign(next.values, { [field]: value })
    delete next.conflicts[field]
  }
  return next
}
