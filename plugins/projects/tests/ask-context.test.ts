import { describe, expect, it } from 'bun:test'
import { buildProjectAskContext } from '../index'
import type { Project } from '../types'

function makeProject(): Project {
  return {
    id: 'p1',
    title: 'Messaging Refactor Plan',
    status: 'draft',
    created: '2026-05-08',
    updated: '2026-05-08',
    owner: 'mark',
    tasks: [],
    assets: [],
    body: '# Messaging Refactor Plan',
    progress: 0,
  }
}

describe('buildProjectAskContext', () => {
  it('guides Bakin ticket lookups toward targeted GitHub issue commands', () => {
    const context = buildProjectAskContext(
      makeProject(),
      'look for tickets in the Bakin repo that are related',
    )

    expect(context).toContain('Lookup guidance:')
    expect(context).toContain('markhayden/bakin')
    expect(context).toContain('gh issue list --repo markhayden/bakin')
    expect(context).toContain('Do not load broad GitHub workflow skills or scan the filesystem')
  })

  it('does not add ticket lookup guidance for ordinary brainstorm prompts', () => {
    const context = buildProjectAskContext(makeProject(), 'walk through the user experience')

    expect(context).not.toContain('Lookup guidance:')
  })

  it('does not replay persisted brainstorm messages into stable runtime threads', () => {
    const context = buildProjectAskContext(
      makeProject(),
      'continue the plan',
      [
        { id: 'm1', role: 'user', content: 'old user turn that should not be pasted', timestamp: '2026-05-08T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'old assistant turn that should not be pasted', timestamp: '2026-05-08T00:00:01.000Z' },
      ],
    )

    expect(context).toContain('Conversation continuity:')
    expect(context).toContain('stable runtime thread')
    expect(context).not.toContain('Previous conversation in this brainstorm session')
    expect(context).not.toContain('old user turn that should not be pasted')
    expect(context).not.toContain('old assistant turn that should not be pasted')
  })
})
