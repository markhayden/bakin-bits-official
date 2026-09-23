import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useProjectHistory } from '../hooks/use-project-history'
const fetchBefore = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = fetchBefore })
const snapshot = { ts: '2026-09-23T10:00:00Z', author: 'agent', body: 'Old' }
it('distinguishes empty from failed and malformed history and allows retry', async () => {
  globalThis.fetch = (async () => Response.json({ history: [] })) as typeof fetch
  const view = renderHook(() => useProjectHistory('a', 'Body'))
  await waitFor(() => expect(view.result.current.history).toEqual([]))
  globalThis.fetch = (async () => Response.json({ error: 'Storage unavailable' }, { status: 503 })) as typeof fetch
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.error?.message).toBe('Storage unavailable')
  globalThis.fetch = (async () => Response.json({ history: [{ ...snapshot, ts: 'invalid' }] })) as typeof fetch
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.error?.code).toBe('invalid_response')
  globalThis.fetch = (async () => Response.json({ history: [snapshot] })) as typeof fetch
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.error).toBeNull()
  expect(view.result.current.history).toEqual([snapshot])
})
it('ignores earlier project and body responses even when abort is ignored', async () => {
  const pending: ((value: Response) => void)[] = []
  const signals: AbortSignal[] = []
  globalThis.fetch = ((_url, init) => { signals.push(init.signal); return new Promise(resolve => pending.push(resolve)) }) as typeof fetch
  const view = renderHook(({ id, body }) => useProjectHistory(id, body), { initialProps: { id: 'a', body: 'first' } })
  view.rerender({ id: 'b', body: 'second' })
  view.rerender({ id: 'b', body: 'third' })
  await act(async () => pending[2]!(Response.json({ history: [snapshot] })))
  await act(async () => pending[1]!(Response.json({ history: [] })))
  await act(async () => pending[0]!(Response.json({ history: [] })))
  expect(view.result.current.history).toEqual([snapshot])
  view.unmount()
  expect(signals.at(-1)?.aborted).toBe(true)
})
