import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useProjectDetail } from '../hooks/use-project-detail'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const project = (id: string, title = id) => ({
  id, title, status: 'draft', owner: '', tasks: [], assets: [], body: '', progress: 0,
  created: '2026-09-23T00:00:00Z', updated: '2026-09-23T00:00:00Z', resolvedTasks: {}, resolvedAssets: [],
})
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}

describe('project detail requests', () => {
  it('ignores obsolete project responses even when fetch does not honor abort', async () => {
    const a = deferred(); const b = deferred()
    globalThis.fetch = ((url: string) => url.endsWith('/a') ? a.promise : b.promise) as typeof fetch
    const view = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: 'a' } })
    view.rerender({ id: 'b' })
    await act(async () => b.resolve(Response.json({ project: project('b') })))
    await waitFor(() => expect(view.result.current.project?.id).toBe('b'))
    await act(async () => a.resolve(Response.json({ project: project('a') })))
    expect(view.result.current.project?.id).toBe('b')
    expect(view.result.current.error).toBeNull()
  })

  it('retains valid data on refresh failure and clears the error after retry', async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({ project: project('a') }))) as typeof fetch
    const view = renderHook(() => useProjectDetail('a'))
    await waitFor(() => expect(view.result.current.project?.id).toBe('a'))
    globalThis.fetch = (() => Promise.resolve(Response.json({ error: 'Disk unavailable' }, { status: 503 }))) as typeof fetch
    await act(async () => { await view.result.current.refresh() })
    expect(view.result.current.project?.id).toBe('a')
    expect(view.result.current.error?.status).toBe(503)
    globalThis.fetch = (() => Promise.resolve(Response.json({ project: project('a', 'Fresh') }))) as typeof fetch
    await act(async () => { await view.result.current.refresh() })
    expect(view.result.current.project?.title).toBe('Fresh')
    expect(view.result.current.error).toBeNull()
  })

  it('distinguishes missing, network and invalid-data failures', async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({}, { status: 404 }))) as typeof fetch
    const view = renderHook(() => useProjectDetail('a'))
    await waitFor(() => expect(view.result.current.error?.status).toBe(404))
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
    await act(async () => { await view.result.current.refresh() })
    expect(view.result.current.error?.status).toBe(0)
    globalThis.fetch = (() => Promise.resolve(Response.json({ project: { id: 'a' } }))) as typeof fetch
    await act(async () => { await view.result.current.refresh() })
    expect(view.result.current.error?.code).toBe('invalid_response')
  })

  it('ignores earlier refresh completion and aborts on unmount', async () => {
    const pending: ReturnType<typeof deferred>[] = []
    const signals: AbortSignal[] = []
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      const request = deferred(); pending.push(request); return request.promise
    }) as typeof fetch
    const view = renderHook(() => useProjectDetail('a'))
    let refresh!: Promise<unknown>
    act(() => { refresh = view.result.current.refresh() })
    await act(async () => { pending[1]!.resolve(Response.json({ project: project('a', 'Latest') })); await refresh })
    await act(async () => pending[0]!.resolve(Response.json({ project: project('a', 'Stale') })))
    expect(view.result.current.project?.title).toBe('Latest')
    act(() => { void view.result.current.refresh() })
    view.unmount()
    expect(signals.at(-1)?.aborted).toBe(true)
    pending.at(-1)!.resolve(Response.json({ project: project('a') }))
  })
})
