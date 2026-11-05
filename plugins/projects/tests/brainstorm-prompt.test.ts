/**
 * The staged brainstorm posture (D14): one builder, three stages, live vs
 * relayed asking. Pure — no storage.
 */
import { describe, expect, it } from 'bun:test'

import { buildProjectBrainstormContext, projectBrainstormInstructions } from '../lib/brainstorm-prompt'
import { BRIEF_HEADINGS } from '../lib/brief'
import type { Project } from '../types'

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1', title: 'Inbox cleanup', titleSource: 'agent', status: 'draft', created: '', updated: '',
  owner: 'main', tasks: [], assets: [], body: '', progress: 0, planRevision: 0, ...overrides,
})

/** The three later stages, pinned byte for byte: the interview changes only the draft stage. */
const ACTIVE_LIVE = [
  'Project progress mode — you are the user\'s progress buddy: what is blocked, what is next, and whether the scope still holds.',
  'Do not interview the user unless they ask. Keep the plan and its steps current with bakin_exec_projects_apply_plan and the step tools, and say what you changed.',
  'Only when a real decision is needed: Ask exactly ONE question per turn with bakin_exec_ask_user (2–5 options, mark the one you recommend), then end your turn and wait for the answer.',
]
const ACTIVE_RELAYED = [
  ACTIVE_LIVE[0]!,
  ACTIVE_LIVE[1]!,
  'Only when a real decision is needed: Ask at most ONE question, in plain text, and mark the answer you recommend.',
]
const COMPLETED = ['Project retrospective mode — the project is complete. Answer questions and reflect on what happened; change the plan only when the user asks.']
const ARCHIVED = ['Project retrospective mode — the project is archived. Answer questions; change the plan only when the user asks.']
const SHARED = [
  'Every plan edit is snapshotted with a visible diff and one-click restore, so direct edits are safe.',
  'You cannot start, complete or archive the project — those are the user\'s decisions.',
  'Invoke Bakin tools as described in your Tool access section — the exact call form depends on the active runtime.',
]

describe('projectBrainstormInstructions — the shaping interview (projects-grill-start D4)', () => {
  const text = projectBrainstormInstructions('draft', { live: true })

  it('walks five areas in order, skipping what is answered and following dependencies', () => {
    const areas = ['Goal —', 'What success looks like —', 'Scope —', 'Constraints and dependencies —', 'Risks and open questions —']
    const positions = areas.map(area => text.indexOf(area))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(text).toContain('skipping what the user already answered')
    expect(text).toContain('this is the definition of done')
  })

  it('asks at most one question per turn, always with a recommendation, and simplifies tangled answers', () => {
    expect(text).toContain('AT MOST one question')
    expect(text).toContain('bakin_exec_ask_user')
    expect(text).toContain('ALWAYS set `recommended` and say why')
    expect(text).toContain('Never ask two things at once')
    expect(text).toContain('reflect it back as two or three simpler choices')
    // Live acceptance 2026-11-04: the lead asked for the travel year, exact dates and which
    // days count — details a draft carries as assumptions. The rule names them.
    expect(text).toContain('Prefer a labelled assumption to a question whenever the plan would have the same shape either way')
    expect(text).toContain('Ask only questions whose answers would materially change the plan.')
    expect(text).toContain('one line that sets expectations')
    expect(text).not.toContain('brainstorm buddy')
  })

  it('keeps the brief in the plan body under the seeded headings, updated after decisions land', () => {
    for (const heading of BRIEF_HEADINGS) expect(text).toContain(heading)
    expect(text).toContain('a resolved section, not every reply')
    expect(text).toContain('bakin_exec_projects_apply_plan')
    expect(text).toContain('Keep each Open questions entry a list item')
    expect(text).toContain('set a short title')
  })

  it('states the stopping rule: draft once the four blocking gaps close, carry the rest as labelled assumptions, converge after the draft', () => {
    expect(text).toContain('The blocking gaps are the goal, what success looks like, the scope boundary, and the hard constraints and dependencies.')
    expect(text).toContain('checklistItems')
    expect(text).toContain('Draft plan is ready in the Plan tab')
    expect(text).toContain('labelled as assumptions')
    expect(text).toContain('first message already covers those four areas, draft in that same turn')
    expect(text).toContain('ask again only if the answer could change scope, feasibility, sequencing or success criteria')
    expect(text).toContain('never an obligation to keep generating questions')
    expect(text).toContain('"just write it"')
    expect(text).toContain('keep unresolved blockers under Open questions rather than inventing answers')
  })

  it('the later stages are unchanged, byte for byte', () => {
    expect(projectBrainstormInstructions('active', { live: true })).toBe([...ACTIVE_LIVE, ...SHARED].join('\n'))
    expect(projectBrainstormInstructions('active', { live: false })).toBe([...ACTIVE_RELAYED, ...SHARED].join('\n'))
    expect(projectBrainstormInstructions('completed', { live: true })).toBe([...COMPLETED, ...SHARED].join('\n'))
    expect(projectBrainstormInstructions('archived', { live: true })).toBe([...ARCHIVED, ...SHARED].join('\n'))
  })

  it('relayed (non-live) asking never mentions the card tool, in any stage', () => {
    expect(projectBrainstormInstructions('draft', { live: false })).not.toContain('bakin_exec_ask_user')
    expect(projectBrainstormInstructions('draft', { live: false })).toContain('AT MOST one question')
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
