// @vitest-environment jsdom
/** The composer paperclip (D17) attaches to the project, not the message. */
import { afterEach, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useProjectUploads } from '../hooks/use-project-uploads'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

it('uploads to the asset library, attaches to the project, then clears the chip', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`)
    if (url === '/api/plugins/assets/upload') return Response.json({ ok: true, assetId: 'a1', filename: 'notes.md' })
    return Response.json({ ok: true })
  }) as typeof fetch
  const onAttached = mock(async () => {})
  const view = renderHook(() => useProjectUploads('p1', onAttached))
  await act(async () => { view.result.current.onAdd([new File(['# notes'], 'notes.md', { type: 'text/markdown' })]) })
  await waitFor(() => expect(view.result.current.items).toHaveLength(0))
  expect(calls).toEqual(['POST /api/plugins/assets/upload', 'POST /api/plugins/projects/p1/assets'])
  expect(onAttached).toHaveBeenCalled()
})

it('a failed upload stays on its chip with the reason', async () => {
  globalThis.fetch = (async () => Response.json({ ok: false, error: 'File "big.mov" exceeds 50MB limit' }, { status: 413 })) as typeof fetch
  const view = renderHook(() => useProjectUploads('p1', async () => {}))
  await act(async () => { view.result.current.onAdd([new File(['x'], 'big.mov', { type: 'video/quicktime' })]) })
  await waitFor(() => expect(view.result.current.items[0]?.status).toBe('error'))
  expect(view.result.current.items[0]?.errorMessage).toBe('File "big.mov" exceeds 50MB limit')
})
