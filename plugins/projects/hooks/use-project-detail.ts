import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectApiError, readProjectDetail } from '../lib/project-api'
import type { ProjectDetailData } from '../types'

interface DetailState {
  id: string
  project: ProjectDetailData | null
  loading: boolean
  error: ProjectApiError | null
}

/** Abort is cleanup; identity and generation checks establish correctness. */
export function useProjectDetail(id: string) {
  const [state, setState] = useState<DetailState>({ id, project: null, loading: Boolean(id), error: null })
  const identity = useRef(id)
  identity.current = id
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async (): Promise<ProjectDetailData | null> => {
    if (!id) return null
    const request = ++generation.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setState(previous => ({ id, project: previous.id === id ? previous.project : null, loading: true, error: null }))
    try {
      const project = await readProjectDetail(id, abort.signal)
      if (abort.signal.aborted || identity.current !== id || generation.current !== request) return null
      setState({ id, project, loading: false, error: null })
      return project
    } catch (error) {
      if (abort.signal.aborted || identity.current !== id || generation.current !== request) return null
      const failure = error instanceof ProjectApiError ? error : new ProjectApiError('Project could not be loaded. Try again.', 0)
      setState(previous => ({ ...previous, loading: false, error: failure }))
      return null
    }
  }, [id])

  useEffect(() => {
    void refresh()
    return () => { generation.current++; controller.current?.abort() }
  }, [refresh])

  const current = state.id === id ? state : { id, project: null, loading: Boolean(id), error: null }
  return { ...current, refresh }
}
