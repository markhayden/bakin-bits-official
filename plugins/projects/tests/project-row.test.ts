/** The resume-signal priority (D18) — pure. */
import { expect, it } from 'bun:test'
import { resumeSignal } from '../components/project-row'
import type { ProjectSummary } from '../types'

const base: ProjectSummary = { id: 'p', title: 'P', status: 'active', owner: 'main', progress: 0, taskCount: 4, doneCount: 1, assetCount: 0, updated: '' }

it('ranks waiting › working › new reply › plan updated › progress', () => {
  const all = { ...base, waitingForYou: true, brainstormStreaming: true, brainstormUnread: true, planUpdated: true }
  expect(resumeSignal(all, 'Roscoe').text).toBe('Waiting for you')
  expect(resumeSignal({ ...all, waitingForYou: false }, 'Roscoe').text).toBe('Roscoe is working')
  expect(resumeSignal({ ...all, waitingForYou: false, brainstormStreaming: false }, 'Roscoe').text).toBe('New reply from Roscoe')
  expect(resumeSignal({ ...base, planUpdated: true }, 'Roscoe').text).toBe('Plan updated')
  expect(resumeSignal(base, 'Roscoe').text).toBe('1 of 4 steps done')
  expect(resumeSignal({ ...base, taskCount: 0 }, 'Roscoe').text).toBe('No steps yet')
})
