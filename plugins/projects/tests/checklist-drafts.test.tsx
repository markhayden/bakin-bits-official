import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useChecklistDrafts } from '../hooks/use-checklist-drafts'
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const tasks = [{ id: 't001', instanceId: 'one', title: 'First', description: 'Old', checked: false }, { id: 't002', instanceId: 'two', title: 'Second', description: '', checked: false }]
it('retains failed adds with the same retry identity and clears only the confirmed snapshot', async () => {
  const requests: any[] = []
  let fail = true
  globalThis.fetch = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); if (fail) throw new Error('offline'); return Response.json({ ok: true, taskItemId: 't003' }) }) as typeof fetch
  const view = renderHook(() => useChecklistDrafts('p1', tasks, async () => null))
  act(() => view.result.current.setNewTitle('New task'))
  await act(async () => { expect(await view.result.current.add()).toBe(false) })
  expect(view.result.current.newTitle).toBe('New task')
  fail = false
  await act(async () => { expect(await view.result.current.add()).toBe(true) })
  expect(requests[0].requestId).toBe(requests[1].requestId)
  expect(view.result.current.newTitle).toBe('')
})
it('retains failed description edits, accepts untouched remote changes and blocks overlap', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'Failed' }, { status: 500 })) as typeof fetch
  const view = renderHook(({ items }) => useChecklistDrafts('p1', items, async () => null), { initialProps: { items: tasks } })
  act(() => view.result.current.editDescription(tasks[0]!, 'Mine'))
  await act(async () => { expect(await view.result.current.saveDescription('t001')).toBe(false) })
  expect(view.result.current.descriptions.t001?.value).toBe('Mine')
  view.rerender({ items: [{ ...tasks[0]!, description: 'Agent' }, tasks[1]!] })
  expect(view.result.current.descriptions.t001?.conflict).toBe(true)
  act(() => view.result.current.resolveDescription('t001', 'latest'))
  expect(view.result.current.descriptions.t001?.value).toBe('Agent')
})
it('save all remembers partial successes and retries only pending drafts', async () => {
  const urls: string[] = []
  let fail = true
  globalThis.fetch = (async (url) => { urls.push(String(url)); return fail && String(url).endsWith('/t002') ? Response.json({ error: 'Second failed' }, { status: 503 }) : Response.json({ ok: true }) }) as typeof fetch
  const view = renderHook(() => useChecklistDrafts('p1', tasks, async () => null))
  act(() => { view.result.current.editDescription(tasks[0]!, 'One'); view.result.current.editDescription(tasks[1]!, 'Two') })
  await act(async () => { expect(await view.result.current.saveAll()).toBe(false) })
  fail = false
  await act(async () => { expect(await view.result.current.saveAll()).toBe(true) })
  expect(urls.filter(url => url.endsWith('/t001'))).toHaveLength(1)
  expect(urls.filter(url => url.endsWith('/t002'))).toHaveLength(2)
})
