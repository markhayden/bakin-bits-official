// @vitest-environment jsdom
/**
 * Project header (D11–D13): one next-step button per status, confirmations
 * where they matter, expected-status writes, unarchive to `archivedFrom`, the
 * rename dialog, and the Details lead picker.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { ProjectHeader, nextStepFor } from '../components/project-header'
import type { ProjectDetailData } from '../types'

const agents = [{ id: 'main', name: 'Roscoe' }, { id: 'scout', name: 'Scout' }]
const project = (overrides: Partial<ProjectDetailData> = {}): ProjectDetailData => ({
  id: 'p1', title: 'Inbox cleanup', titleSource: 'agent', status: 'draft', created: '2026-10-25T00:00:00.000Z',
  updated: '2026-10-25T00:00:00.000Z', owner: 'main', tasks: [], assets: [], body: '', progress: 0, planRevision: 0,
  resolvedTasks: {}, resolvedAssets: [], ...overrides,
})

const fetchMock = mock(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
let onChanged: ReturnType<typeof mock>

beforeEach(() => {
  fetchMock.mockClear()
  onChanged = mock(async () => {})
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => cleanup())

function renderHeader(overrides: Partial<ProjectDetailData> = {}, onReviewSteps?: () => void) {
  return render(<ProjectHeader project={project(overrides)} agents={agents} onBack={() => {}} onChanged={onChanged} onDelete={() => {}} onReviewSteps={onReviewSteps} />)
}

const steps = (titles: string[], checked: boolean[] = []) => titles.map((title, i) => ({ id: `t00${i + 1}`, title, checked: checked[i] ?? false }))

describe('steward controls (D27, D28, D29)', () => {
  it('Start is the hand-off: the lead takes it from here, with the step count and a way back to the steps', async () => {
    const onReviewSteps = mock(() => {})
    renderHeader({ tasks: steps(['Draft copy', 'Pick photos']) }, onReviewSteps)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start project' })) })
    const dialog = screen.getByRole('dialog', { name: 'Start project?' })
    expect(dialog.textContent).toContain('Roscoe takes it from here — sends steps to the board, assigns each to the right agent or keeps it, and checks in as work moves.')
    expect(dialog.textContent).toContain('2 steps in the plan.')
    expect(dialog.querySelector('p div, p button')).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Review steps first' })) })
    expect(onReviewSteps).toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Start project?' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Start with no steps says the lead breaks the plan down first', async () => {
    renderHeader({}, () => {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start project' })) })
    const dialog = screen.getByRole('dialog', { name: 'Start project?' })
    expect(dialog.textContent).toContain('No steps yet — Roscoe breaks the plan down first.')
    expect(within(dialog).queryByRole('button', { name: 'Review steps first' })).toBeNull()
  })

  it('Mark complete names the unfinished steps before completing anyway', async () => {
    renderHeader({ status: 'active', tasks: steps(['Draft copy', 'Pick photos', 'Ship'], [false, true, false]) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark complete' })) })
    const dialog = screen.getByRole('dialog', { name: 'Mark complete?' })
    expect(dialog.textContent).toContain('2 steps aren\'t done — complete anyway?')
    expect(within(dialog).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Draft copy', 'Ship'])
    // The description is phrasing content (a paragraph in the real dialog); the list rides the body.
    expect(dialog.querySelector('p ul, p div')).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Complete anyway' })) })
    expect(bodies()).toEqual([{ status: 'completed', expected: { status: 'active' } }])
  })

  it('pauses and resumes check-ins from the ⋯ menu (menu items render as buttons in the stub); paused shows a badge', async () => {
    const { unmount } = renderHeader({ status: 'active' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause check-ins' })) })
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/plugins/projects/p1/steward/pause')
    expect(bodies()).toEqual([{ paused: true }])
    expect(onChanged).toHaveBeenCalled()
    expect(screen.queryByText('Paused')).toBeNull()
    unmount()

    fetchMock.mockClear()
    renderHeader({ status: 'active', stewardPaused: true })
    expect(screen.getByText('Paused')).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume check-ins' })) })
    expect(bodies()).toEqual([{ paused: false }])
  })

  it('offers no check-in controls outside an active project', async () => {
    renderHeader({ status: 'draft', stewardPaused: true })
    expect(screen.queryByText('Paused')).toBeNull()
    expect(screen.queryByRole('button', { name: /check-ins/ })).toBeNull()
  })
})

describe('nextStepFor', () => {
  it('maps every status to one primary action', () => {
    expect(nextStepFor(project({ status: 'draft' }), 'Roscoe')).toMatchObject({ label: 'Start project', to: 'active' })
    expect(nextStepFor(project({ status: 'active' }), 'Roscoe')).toMatchObject({ label: 'Mark complete', to: 'completed' })
    expect(nextStepFor(project({ status: 'active' }), 'Roscoe').confirm).toBeUndefined()
    expect(nextStepFor(project({ status: 'completed' }), 'Roscoe')).toMatchObject({ label: 'Reopen', to: 'active' })
    expect(nextStepFor(project({ status: 'archived', archivedFrom: 'completed' }), 'Roscoe')).toMatchObject({ label: 'Unarchive', to: 'completed' })
  })

  it('completing with unfinished steps asks first', () => {
    const step = nextStepFor(project({ status: 'active', tasks: [{ id: 't001', title: 'a', checked: false }, { id: 't002', title: 'b', checked: true }] }), 'Roscoe')
    expect(step.confirm).toMatchObject({ title: 'Mark complete?', confirmLabel: 'Complete anyway' })
  })
})

describe('ProjectHeader', () => {
  it('Start project confirms, then writes active against the expected draft status', async () => {
    renderHeader()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start project' })) })
    const dialog = screen.getByRole('dialog', { name: 'Start project?' })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Start project' })) })
    expect(bodies()).toEqual([{ status: 'active', expected: { status: 'draft' } }])
    expect(onChanged).toHaveBeenCalled()
  })

  it('Reopen and Unarchive are direct; unarchive returns to the archived-from status', async () => {
    renderHeader({ status: 'archived', archivedFrom: 'active' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unarchive' })) })
    expect(bodies()).toEqual([{ status: 'active', expected: { status: 'archived' } }])
  })

  it('there is no status picker — only the badge and the one action', () => {
    renderHeader({ status: 'active' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('Active')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDefined()
  })

  it('renames through the dialog: Enter saves with the expected title', async () => {
    renderHeader()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rename project' })) })
    // The kit Field labels its control; the unit stub does not wire that up.
    const input = within(screen.getByRole('dialog', { name: 'Rename project' })).getByRole('textbox')
    await act(async () => { fireEvent.change(input, { target: { value: 'Inbox zero' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(bodies()).toEqual([{ title: 'Inbox zero', expected: { title: 'Inbox cleanup' } }])
    expect(screen.queryByRole('dialog', { name: 'Rename project' })).toBeNull()
  })

  it('the rename expects the title from when the dialog opened, not a later refresh', async () => {
    const view = renderHeader()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rename project' })) })
    // A background rename lands while the dialog is open.
    view.rerender(<ProjectHeader project={project({ title: 'Agent renamed' })} agents={agents} onBack={() => {}} onChanged={onChanged} onDelete={() => {}} />)
    const input = within(screen.getByRole('dialog', { name: 'Rename project' })).getByRole('textbox')
    await act(async () => { fireEvent.change(input, { target: { value: 'Mine' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(bodies()).toEqual([{ title: 'Mine', expected: { title: 'Inbox cleanup' } }])
  })

  it('a confirmation expects the status it was offered from', async () => {
    const view = renderHeader()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start project' })) })
    view.rerender(<ProjectHeader project={project({ status: 'active' })} agents={agents} onBack={() => {}} onChanged={onChanged} onDelete={() => {}} />)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Start project?' })).getByRole('button', { name: 'Start project' })) })
    expect(bodies()).toEqual([{ status: 'active', expected: { status: 'draft' } }])
  })

  it('a rename conflict stays in the dialog with the error', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'Some fields changed while you were editing.' }, { status: 409 }))
    renderHeader()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rename project' })) })
    await act(async () => { fireEvent.change(within(screen.getByRole('dialog', { name: 'Rename project' })).getByRole('textbox'), { target: { value: 'Mine' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(screen.getByText('Some fields changed while you were editing.')).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Rename project' })).toBeDefined()
  })

  it('Details changes the lead agent with the expected owner', async () => {
    renderHeader()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Details' })) })
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Lead agent' }), { target: { value: 'scout' } }) })
    expect(bodies()).toEqual([{ owner: 'scout', expected: { owner: 'main' } }])
  })
})
