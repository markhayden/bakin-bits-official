import { useEffect, useRef, useState } from 'react'
import type { ProjectTask } from '../types'
import { ProjectApiError, projectRequest } from '../lib/project-api'

export interface DescriptionDraft {
  item: ProjectTask
  baseline: string
  value: string
  latest: string
  conflict: boolean
  removed: boolean
}
interface ChecklistState {
  newTitle: string
  addIntent?: { requestId: string; title: string; raw: string }
  descriptions: Record<string, DescriptionDraft>
  errors: Record<string, string>
  busy: Record<string, boolean>
}
const empty = (): ChecklistState => ({ newTitle: '', descriptions: {}, errors: {}, busy: {} })
export function useChecklistDrafts(projectId: string, tasks: ProjectTask[], refresh: () => Promise<unknown>) {
  const [state, setState] = useState(empty)
  const current = useRef(state)
  const owner = useRef(projectId)
  owner.current = projectId
  const latestTasks = useRef(tasks)
  latestTasks.current = tasks
  const requestIds = useRef(new Map<string, string>())
  function update(patch: Partial<ChecklistState>) { current.current = { ...current.current, ...patch }; setState(current.current) }
  function description(id: string, next: DescriptionDraft) { update({ descriptions: { ...current.current.descriptions, [id]: next } }) }
  function clearError(key: string) { const errors = { ...current.current.errors }; delete errors[key]; update({ errors }) }
  function failure(key: string, error: unknown) { update({ errors: { ...current.current.errors, [key]: error instanceof Error ? error.message : String(error) } }) }
  useEffect(() => {
    owner.current = projectId
    return () => { owner.current = '' }
  }, [projectId])
  useEffect(() => {
    const descriptions = { ...current.current.descriptions }
    for (const [id, draft] of Object.entries(descriptions)) {
      const item = tasks.find(task => task.id === id)
      if (!item || (draft.item.instanceId && item.instanceId !== draft.item.instanceId)) { descriptions[id] = { ...draft, removed: true }; continue }
      const latest = item.description ?? ''
      const clean = draft.value === draft.baseline || draft.value === latest
      descriptions[id] = { ...draft, item, latest, removed: false, baseline: clean ? latest : draft.baseline, value: clean ? latest : draft.value, conflict: !clean && latest !== draft.baseline }
    }
    update({ descriptions })
  }, [tasks])

  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    if (current.current.busy[key]) return false
    clearError(key); update({ busy: { ...current.current.busy, [key]: true } })
    try {
      await action()
      if (owner.current !== projectId) return false
      await refresh()
      return true
    } catch (error) {
      if (owner.current === projectId) failure(key, error)
      return false
    } finally {
      if (owner.current === projectId) update({ busy: { ...current.current.busy, [key]: false } })
    }
  }
  function editDescription(item: ProjectTask, value: string) {
    const prior = current.current.descriptions[item.id] ?? { item, baseline: item.description ?? '', latest: item.description ?? '', removed: false, conflict: false, value: item.description ?? '' }
    description(item.id, { ...prior, value, conflict: value !== prior.latest && value !== prior.baseline && prior.latest !== prior.baseline })
    clearError(item.id)
  }
  function resolveDescription(id: string, choice: 'mine' | 'latest') {
    const draft = current.current.descriptions[id]
    if (!draft) return
    description(id, { ...draft, baseline: draft.latest, value: choice === 'latest' ? draft.latest : draft.value, conflict: false })
    clearError(id)
  }
  async function saveDescription(id: string) {
    const draft = current.current.descriptions[id]
    if (!draft || draft.value === draft.baseline) return true
    if (draft.removed || draft.conflict) { failure(id, new Error(draft.removed ? 'This checklist item was removed. Discard its draft to continue.' : 'Review the overlapping description changes.')); return false }
    return run(id, async () => {
      try {
        await projectRequest(`${encodeURIComponent(projectId)}/checklist/${encodeURIComponent(id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: draft.value, expected: { description: draft.baseline }, expectedInstanceId: draft.item.instanceId ?? '' }),
        })
      } catch (error) {
        if (error instanceof ProjectApiError && error.status === 409) {
          const latest = (error.detail as { conflicts?: { description?: { current?: unknown } } })?.conflicts?.description?.current
          if (typeof latest === 'string') description(id, { ...current.current.descriptions[id]!, latest, conflict: true })
        }
        throw error
      }
      if (owner.current !== projectId) return
      const now = current.current.descriptions[id]!
      description(id, { ...now, baseline: draft.value, latest: draft.value, conflict: false })
    })
  }
  async function add() {
    if (!current.current.newTitle.trim() && !current.current.addIntent) return true
    const intent = current.current.addIntent ?? { requestId: crypto.randomUUID(), title: current.current.newTitle.trim(), raw: current.current.newTitle }
    update({ addIntent: intent })
    return run('add', async () => {
      const result = await projectRequest(`${encodeURIComponent(projectId)}/checklist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: intent.title, requestId: intent.requestId }) }) as { deleted?: boolean }
      if (owner.current !== projectId) return
      update({ addIntent: undefined, newTitle: current.current.newTitle === intent.raw ? '' : current.current.newTitle })
      if (result.deleted) failure('add', new Error('This task was already added, then removed. Refresh to review the checklist.'))
    })
  }
  const isDirty = () => Boolean(current.current.newTitle.trim() || current.current.addIntent || Object.values(current.current.descriptions).some(draft => draft.value !== draft.baseline))
  function validate() {
    const unresolved = Object.entries(current.current.descriptions).find(([, draft]) => draft.value !== draft.baseline && (draft.conflict || draft.removed))
    if (unresolved) { failure(unresolved[0], new Error('Resolve or discard this description draft before leaving.')); return false }
    return true
  }
  async function saveAll() {
    if (!validate()) return false
    for (const id of Object.keys(current.current.descriptions).sort()) if (!await saveDescription(id)) return false
    if (!await add()) return false
    return !isDirty()
  }
  async function mutate(item: ProjectTask, action: 'toggle' | 'remove' | 'promote', checked?: boolean) {
    return run(item.id, async () => {
      if (!latestTasks.current.some(task => task.id === item.id && task.instanceId === item.instanceId)) throw new Error('This checklist item changed or was removed. Refresh to review.')
      const key = `${item.instanceId ?? item.id}:${action}`
      let requestId = requestIds.current.get(key)
      if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(key, requestId) }
      const suffix = action === 'remove' ? '' : `/${action}`
      await projectRequest(`${encodeURIComponent(projectId)}/checklist/${encodeURIComponent(item.id)}${suffix}`, {
        method: action === 'remove' ? 'DELETE' : action === 'toggle' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked, requestId, expectedInstanceId: item.instanceId ?? '' }),
      })
    })
  }
  return {
    ...state, editDescription, resolveDescription, saveDescription, add, mutate, validate, saveAll, isDirty,
    dirty: isDirty(), saving: Object.values(state.busy).some(Boolean),
    setNewTitle: (newTitle: string) => update({ newTitle }),
    discardDescription: (id: string) => { if (current.current.busy[id]) return; const descriptions = { ...current.current.descriptions }; delete descriptions[id]; update({ descriptions }); clearError(id) },
    discardAll: () => { if (!Object.values(current.current.busy).some(Boolean)) { current.current = empty(); setState(current.current) } },
  }
}
