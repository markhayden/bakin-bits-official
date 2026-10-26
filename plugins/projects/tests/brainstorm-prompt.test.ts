/**
 * The staged brainstorm posture (D14): one builder, three stages, live vs
 * relayed asking. Pure — no storage.
 */
import { describe, expect, it } from 'bun:test'

import { buildProjectBrainstormContext, projectBrainstormInstructions } from '../lib/brainstorm-prompt'
import type { Project } from '../types'

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1', title: 'Inbox cleanup', titleSource: 'agent', status: 'draft', created: '', updated: '',
  owner: 'main', tasks: [], assets: [], body: '', progress: 0, planRevision: 0, ...overrides,
})

describe('projectBrainstormInstructions', () => {
  it('shaping: one question card per turn, draft once goal/scope/done are answered, name the project', () => {
    const text = projectBrainstormInstructions('draft', { live: true })
    expect(text).toContain('brainstorm buddy')
    expect(text).toContain('bakin_exec_ask_user')
    expect(text).toContain('Ask only questions whose answers would materially change the plan.')
    expect(text).toContain('Draft plan is ready in the Plan tab')
    expect(text).toContain('just write it')
    expect(text).toContain('set a short title')
  })

  it('active: progress buddy, no interviewing; cards only for real decisions', () => {
    const text = projectBrainstormInstructions('active', { live: true })
    expect(text).toContain('progress buddy')
    expect(text).toContain('Do not interview the user unless they ask.')
    expect(text).not.toContain('brainstorm buddy')
  })

  it('completed and archived: retrospective only', () => {
    expect(projectBrainstormInstructions('completed', { live: true })).toContain('retrospective')
    expect(projectBrainstormInstructions('archived', { live: true })).toContain('retrospective')
    expect(projectBrainstormInstructions('completed', { live: true })).not.toContain('bakin_exec_ask_user')
  })

  it('every stage states the authority limit', () => {
    for (const status of ['draft', 'active', 'completed', 'archived'] as const) {
      expect(projectBrainstormInstructions(status, { live: true })).toContain('cannot start, complete or archive')
    }
  })

  it('relayed (non-live) asking never mentions the card tool', () => {
    expect(projectBrainstormInstructions('draft', { live: false })).not.toContain('bakin_exec_ask_user')
    expect(projectBrainstormInstructions('active', { live: false })).not.toContain('bakin_exec_ask_user')
  })
})

describe('buildProjectBrainstormContext', () => {
  it('reports derived progress in words and flags linked steps as board-driven', () => {
    const text = buildProjectBrainstormContext(project({
      tasks: [
        { id: 't001', title: 'Unsubscribe', checked: true },
        { id: 't002', title: 'Filters', checked: false, taskId: 'board1' },
      ],
      progress: 50,
    }), 'next?', { live: true })
    expect(text).toContain('Progress: 1 of 2 steps done (50%)')
    expect(text).toContain('- [ ] Filters (board task board1 — completes from the board)')
    expect(text).toContain('(empty — nothing drafted yet)')
  })

  it('marks a truncated plan visibly', () => {
    const text = buildProjectBrainstormContext(project({ body: 'x'.repeat(3500) }), 'q', { live: true })
    expect(text).toContain('plan truncated: showing 3000 of 3500 chars')
  })
})
