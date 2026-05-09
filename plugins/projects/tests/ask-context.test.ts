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
})
