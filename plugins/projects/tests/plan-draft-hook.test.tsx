import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { usePlanDraft } from '../hooks/use-plan-draft'
import type { ProjectDetailData } from '../types'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const project: ProjectDetailData = {
  id: 'p1', title: 'Old', titleSource: 'user', owner: 'main', status: 'draft', body: 'Body', created: '', updated: '',
  tasks: [], assets: [], progress: 0, planRevision: 0, resolvedTasks: {}, resolvedAssets: [],
}

it('a failed save keeps the text and sends the expected body', async () => {
  let body: unknown
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ error: 'Disk unavailable' }, { status: 503 }) }) as typeof fetch
  const view = renderHook(() => usePlanDraft('p1', project, async () => null))
  act(() => view.result.current.edit('Mine'))
  await act(async () => { expect(await view.result.current.save()).toBe(false) })
  expect(body).toEqual({ body: 'Mine', expected: { body: 'Body' } })
  expect(view.result.current.draft.value).toBe('Mine')
  expect(view.result.current.error).toBe('Disk unavailable')
})

it('a 409 surfaces the latest body as a conflict to resolve', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'Overlap', conflicts: { body: { current: 'Agent' } } }, { status: 409 })) as typeof fetch
  const view = renderHook(() => usePlanDraft('p1', project, async () => null))
  act(() => view.result.current.edit('Mine'))
  await act(async () => { await view.result.current.save() })
  await waitFor(() => expect(view.result.current.draft.conflict?.latest).toBe('Agent'))
})
