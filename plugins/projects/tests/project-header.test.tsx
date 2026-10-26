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

function renderHeader(overrides: Partial<ProjectDetailData> = {}) {
  return render(<ProjectHeader project={project(overrides)} agents={agents} onBack={() => {}} onChanged={onChanged} onDelete={() => {}} />)
}

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
    expect(step.confirm?.description).toBe('1 of 2 steps isn\'t done yet. You can reopen the project later.')
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
