import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectApiError, projectRequest } from '../lib/project-api'
import type { PlanSnapshot } from '../types'

interface HistoryState {
  identity: string
  history: PlanSnapshot[] | null
  loading: boolean
  error: ProjectApiError | null
}

/** One history request owner shared by rendered comparison and precise line diff. */
export function useProjectHistory(projectId: string, currentBody: string | undefined) {
  const identity = `${projectId}\0${currentBody ?? ''}`
  const latest = useRef(identity)
  latest.current = identity
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const [state, setState] = useState<HistoryState>({ identity, history: null, loading: true, error: null })
  const refresh = useCallback(async () => {
    if (!projectId || currentBody === undefined) return
    const request = ++generation.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setState(previous => ({ identity, history: previous.identity === identity ? previous.history : null, loading: true, error: null }))
    try {
      const data = await projectRequest(`${encodeURIComponent(projectId)}/history`, { signal: abort.signal }) as { history?: unknown }
      if (!data || !Array.isArray(data.history) || !data.history.every(value => value && typeof value === 'object'
        && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))
        && (value.author === 'agent' || value.author === 'user') && typeof value.body === 'string')) {
        throw new ProjectApiError('Projects returned invalid history data.', 502, 'invalid_response')
      }
      if (abort.signal.aborted || latest.current !== identity || generation.current !== request) return
      setState({ identity, history: data.history, loading: false, error: null })
    } catch (error) {
      if (abort.signal.aborted || latest.current !== identity || generation.current !== request) return
      setState(previous => ({ ...previous, loading: false, error: error instanceof ProjectApiError ? error : new ProjectApiError('Plan history is unavailable.', 0) }))
    }
  }, [projectId, currentBody, identity])
  useEffect(() => {
    void refresh()
    return () => { generation.current++; controller.current?.abort() }
  }, [refresh])
  const current = state.identity === identity ? state : { identity, history: null, loading: true, error: null }
  return { ...current, refresh }
}
export type ProjectHistory = ReturnType<typeof useProjectHistory>
