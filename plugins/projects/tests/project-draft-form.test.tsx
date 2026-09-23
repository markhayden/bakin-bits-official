import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectDraftForm } from '../components/project-draft-form'
import { useProjectDraft } from '../hooks/use-project-draft'
import type { ProjectDetailData } from '../types'
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const initial: ProjectDetailData = { id: 'p1', title: 'Old', owner: 'main', status: 'draft', body: 'Body', created: '', updated: '', tasks: [], assets: [], progress: 0, resolvedTasks: {}, resolvedAssets: [] }
function Fixture({ project = initial }: { project?: ProjectDetailData }) {
  const model = useProjectDraft('p1', project, async () => null)
  return <ProjectDraftForm model={model} agents={[{ id: 'main', name: 'Main' }, { id: 'agent', name: 'Agent' }]} />
}
it('stages all fields and saves one expected-value patch', async () => {
  const requests: unknown[] = []
  globalThis.fetch = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }) }) as typeof fetch
  render(<Fixture />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Project title' }), { target: { value: 'New' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project owner' }), { target: { value: 'agent' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Completed' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Project plan' }), { target: { value: 'New body' } })
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(requests).toEqual([{ title: 'New', owner: 'agent', status: 'completed', body: 'New body', expected: { title: 'Old', owner: 'main', status: 'draft', body: 'Body' } }]))
})
it('keeps overlapping drafts visible and requires an explicit resolution', async () => {
  let requests = 0
  globalThis.fetch = (async () => { requests++; return Response.json({ ok: true }) }) as typeof fetch
  const view = render(<Fixture />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Project title' }), { target: { value: 'Mine' } })
  view.rerender(<Fixture project={{ ...initial, title: 'Agent title', owner: 'agent' }} />)
  expect((screen.getByRole('textbox', { name: 'Project title' }) as HTMLInputElement).value).toBe('Mine')
  expect((screen.getByRole('combobox', { name: 'Project owner' }) as HTMLSelectElement).value).toBe('agent')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })))
  expect(requests).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Keep my title' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(requests).toBe(1))
})
it('discards the complete project draft against the latest server values', () => {
  const view = render(<Fixture />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Project title' }), { target: { value: 'Mine' } })
  view.rerender(<Fixture project={{ ...initial, body: 'Agent body' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect((screen.getByRole('textbox', { name: 'Project title' }) as HTMLInputElement).value).toBe('Old')
  expect((screen.getByRole('textbox', { name: 'Project plan' }) as HTMLTextAreaElement).value).toBe('Agent body')
})
