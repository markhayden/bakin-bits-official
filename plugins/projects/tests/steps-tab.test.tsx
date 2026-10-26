// @vitest-environment jsdom
/**
 * Steps (D16/D16a): progress in words, board state in words, Send to board
 * for standalone steps, Open task for linked ones, read-only linked
 * checkboxes, and the empty state.
 */
import { afterEach, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { renderHook } from '@testing-library/react'

import { ProjectChecklist, boardStateLabel } from '../components/project-checklist'
import { useChecklistDrafts } from '../hooks/use-checklist-drafts'
import type { ProjectTask } from '../types'

afterEach(() => cleanup())

const tasks: ProjectTask[] = [
  { id: 't001', instanceId: 'one', title: 'Unsubscribe from lists', checked: false, taskId: 'board-1' },
  { id: 't002', instanceId: 'two', title: 'Write filters', checked: true },
  { id: 't003', instanceId: 'three', title: 'Archive old mail', checked: false },
]

function renderSteps(items: ProjectTask[], resolved = { 'board-1': { column: 'inProgress', title: 'Unsubscribe', agent: 'main' } }) {
  const model = renderHook(() => useChecklistDrafts('p1', items, mock(async () => null))).result.current
  return render(<ProjectChecklist projectId="p1" tasks={items} resolvedTasks={resolved} model={model} />)
}

it('shows progress and each linked step\'s board state in words', () => {
  renderSteps(tasks)
  expect(screen.getByText('1 of 3 steps done')).toBeDefined()
  expect(screen.getByText('In progress · Main')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Open task for Unsubscribe from lists' }).getAttribute('href')).toBe('/tasks?taskId=board-1')
})

it('standalone steps offer Send to board; linked ones do not', () => {
  renderSteps(tasks)
  expect(screen.getByRole('button', { name: 'Send Archive old mail to the board' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Send Unsubscribe from lists to the board' })).toBeNull()
})

it('a linked step\'s checkbox is read-only — it completes from its board task', () => {
  renderSteps(tasks)
  const linked = screen.getByRole('checkbox', { name: 'Unsubscribe from lists completes from its board task' }) as HTMLInputElement
  expect(linked.disabled || linked.getAttribute('aria-disabled') === 'true').toBe(true)
})

it('an empty project explains where steps come from', () => {
  renderSteps([], {})
  expect(screen.getByText('Steps appear once the plan takes shape — or add one.')).toBeDefined()
})

it('boardStateLabel names the board when nobody is assigned', () => {
  expect(boardStateLabel({ column: 'done', title: 'x' })).toBe('Done · board')
})
