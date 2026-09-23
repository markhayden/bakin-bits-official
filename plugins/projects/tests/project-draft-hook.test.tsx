import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useProjectDraft } from '../hooks/use-project-draft'
import type { ProjectDetailData } from '../types'
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const project: ProjectDetailData = { id: 'p1', title: 'Old', owner: 'main', status: 'draft', body: 'Body', created: '', updated: '', tasks: [], assets: [], progress: 0, resolvedTasks: {}, resolvedAssets: [] }
it('reports save failure without clearing values and sends exact expected fields', async () => {
  let body: unknown
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ error: 'Disk unavailable' }, { status: 503 }) }) as typeof fetch
  const view = renderHook(() => useProjectDraft('p1', project, async () => null))
  act(() => view.result.current.edit('title', 'Mine'))
  await act(async () => { expect(await view.result.current.save()).toBe(false) })
  expect(body).toEqual({ title: 'Mine', expected: { title: 'Old' } })
  expect(view.result.current.draft.values.title).toBe('Mine')
  expect(view.result.current.error).toBe('Disk unavailable')
  expect(view.result.current.saving).toBe(false)
})
it('keeps later typing dirty after success and accepts structured server conflicts', async () => {
  let resolve!: (response: Response) => void
  globalThis.fetch = (() => new Promise(done => { resolve = done })) as typeof fetch
  const view = renderHook(() => useProjectDraft('p1', project, async () => null))
  act(() => view.result.current.edit('title', 'Mine'))
  let saving!: Promise<boolean>
  act(() => { saving = view.result.current.save() })
  act(() => view.result.current.edit('title', 'Later'))
  await act(async () => { resolve(Response.json({ ok: true })); expect(await saving).toBe(false) })
  expect(view.result.current.draft.baseline.title).toBe('Mine')
  expect(view.result.current.draft.values.title).toBe('Later')
  globalThis.fetch = (async () => Response.json({ error: 'Overlap', conflicts: { title: { current: 'Agent' } } }, { status: 409 })) as typeof fetch
  await act(async () => { await view.result.current.save() })
  await waitFor(() => expect(view.result.current.draft.conflicts.title?.latest).toBe('Agent'))
})
