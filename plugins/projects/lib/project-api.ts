import { z } from 'zod'
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

const projectSchema = z.object({
  id: z.string(), title: z.string(), status: z.enum(PROJECT_STATUSES), owner: z.string(),
  body: z.string(), created: z.string(), updated: z.string(), progress: z.number().min(0).max(100),
  tasks: z.array(z.object({ id: z.string(), title: z.string(), checked: z.boolean(), description: z.string().optional(), taskId: z.string().optional() })),
  assets: z.array(z.object({ assetId: z.string(), label: z.string().optional() })),
  resolvedTasks: z.record(z.string(), z.object({ column: z.string(), title: z.string() }).nullable()),
  resolvedAssets: z.array(z.object({ assetId: z.string(), type: z.string(), label: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), missing: z.boolean().optional() })),
  brainstormMessages: z.array(z.custom<NonNullable<ProjectDetailData['brainstormMessages']>[number]>(value => value != null && typeof value === 'object' && 'kind' in value && ['user', 'assistant', 'tool', 'error', 'aborted', 'done'].includes(String(value.kind)))).optional(),
})

export async function readProjectDetail(id: string, signal: AbortSignal): Promise<ProjectDetailData> {
  const payload = await projectRequest(encodeURIComponent(id), { signal })
  const parsed = z.object({ project: projectSchema }).safeParse(payload)
  if (!parsed.success || parsed.data.project.id !== id) throw new ProjectApiError('Projects returned invalid project data.', 502, 'invalid_response')
  return parsed.data.project
}
