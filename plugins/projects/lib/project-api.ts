import { PROJECT_STATUSES } from '../types'
import type { ProjectDetailData } from '../types'

export class ProjectApiError extends Error {
  constructor(message: string, readonly status: number, readonly code = 'request_failed', readonly detail?: unknown) {
    super(message)
    this.name = 'ProjectApiError'
  }
}

/** One JSON/error boundary for detail reads and subsequent typed mutations. */
export async function projectRequest(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`/api/plugins/projects/${path}`, init)
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new ProjectApiError('Could not reach Projects. Check your connection and retry.', 0, 'network_error')
  }
  let payload: unknown
  try { payload = await response.json() } catch {
    if (response.ok) throw new ProjectApiError('Projects returned an invalid response.', 502, 'invalid_response')
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    throw new ProjectApiError(typeof error.error === 'string' ? error.error : `Projects request failed (${response.status}).`, response.status, typeof error.code === 'string' ? error.code : 'request_failed', payload)
  }
  return payload
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const string = (value: unknown): value is string => typeof value === 'string'
const optionalString = (value: unknown) => value === undefined || string(value)

function validProject(value: unknown): value is ProjectDetailData {
  if (!record(value)) return false
  return ['id', 'title', 'owner', 'body', 'created', 'updated'].every(field => string(value[field]))
    && PROJECT_STATUSES.some(status => status === value.status)
    && typeof value.progress === 'number' && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100
    && Array.isArray(value.tasks) && value.tasks.every(task => record(task) && string(task.id) && string(task.title) && typeof task.checked === 'boolean' && optionalString(task.description) && optionalString(task.taskId))
    && Array.isArray(value.assets) && value.assets.every(asset => record(asset) && string(asset.assetId) && optionalString(asset.label))
    && record(value.resolvedTasks) && Object.values(value.resolvedTasks).every(task => task === null || (record(task) && string(task.column) && string(task.title)))
    && Array.isArray(value.resolvedAssets) && value.resolvedAssets.every(asset => record(asset) && string(asset.assetId) && string(asset.type) && optionalString(asset.label) && optionalString(asset.description) && (asset.missing === undefined || typeof asset.missing === 'boolean') && (asset.tags === undefined || (Array.isArray(asset.tags) && asset.tags.every(string))))
    && (value.brainstormMessages === undefined || (Array.isArray(value.brainstormMessages) && value.brainstormMessages.every(row => record(row) && ['user', 'assistant', 'tool', 'error', 'aborted', 'done'].includes(String(row.kind)))))
}

export async function readProjectDetail(id: string, signal: AbortSignal): Promise<ProjectDetailData> {
  const payload = await projectRequest(encodeURIComponent(id), { signal })
  if (!record(payload) || !validProject(payload.project) || payload.project.id !== id) throw new ProjectApiError('Projects returned invalid project data.', 502, 'invalid_response')
  return payload.project
}
