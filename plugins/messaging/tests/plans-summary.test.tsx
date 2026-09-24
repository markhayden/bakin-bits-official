import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { emitPluginEvent } from '@makinbakin/sdk/hooks'
import { usePlansSummary } from '../hooks/use-plans-summary'
const originalFetch = globalThis.fetch
const response = (needsReview: number) => Response.json({ needsReview, total: 5 })
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

it('retains Plans on a failed reconnect read and recovers without opening Plans', async () => {
  const fetcher = mock(async () => response(3))
  globalThis.fetch = fetcher as unknown as typeof fetch
  let view!: ReturnType<typeof renderHook<ReturnType<typeof usePlansSummary>, unknown>>
  await act(async () => { view = renderHook(usePlansSummary) })
  expect(view.result.current.summary?.needsReview).toBe(3)
  fetcher.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { emitPluginEvent({ event: 'bakin.reconcile' }) })
  expect(view.result.current.summary?.needsReview).toBe(3)
  expect(view.result.current.error).toBe('offline')
  fetcher.mockImplementation(async () => response(0))
  await act(async () => { emitPluginEvent({ event: 'bakin.reconcile' }) })
  expect(view.result.current.summary?.needsReview).toBe(0)
})

it('receives owned file deletion through the shared bus and rejects older responses', async () => {
  let resolveOld!: (r: Response) => void
  const old = new Promise<Response>((resolve) => { resolveOld = resolve })
  const fetcher = mock(async () => response(3)).mockResolvedValueOnce(response(3)).mockReturnValueOnce(old).mockResolvedValueOnce(response(0))
  globalThis.fetch = fetcher as unknown as typeof fetch
  let view!: ReturnType<typeof renderHook<ReturnType<typeof usePlansSummary>, unknown>>
  await act(async () => { view = renderHook(usePlansSummary) })
  await act(async () => { emitPluginEvent({ event: 'bakin.file.changed', file: 'messaging/plans/one.md', change: 'unlink' }) })
  await act(async () => { emitPluginEvent({ event: 'bakin.reconcile' }) })
  expect(view.result.current.summary?.needsReview).toBe(0)
  await act(async () => { resolveOld(response(56)); await old })
  expect(view.result.current.summary?.needsReview).toBe(0)
})
