/**
 * The steward's plan excerpt reads the plan first (projects-grill-start D7):
 * a long brief never crowds the actionable plan out of a check-in.
 */
import { describe, expect, it } from 'bun:test'

import { STEWARD_PLAN_EXCERPT_BYTES, buildStewardDescription } from '../lib/steward/prompt'
import type { StewardDigest } from '../lib/steward/digest'
import type { Project } from '../types'

const project = (body: string): Project => ({
  id: 'p1', title: 'Inbox cleanup', titleSource: 'agent', status: 'active', created: '', updated: '',
  owner: 'main', tasks: [], assets: [], body, progress: 0, planRevision: 0,
})
const digest: StewardDigest = { projectId: 'p1', signals: [], workTasks: [], fingerprint: 'fp' }
const excerptOf = (description: string) => description.split('## Plan (excerpt)\n')[1]!.split('\nRead the full project')[0]!

describe('buildStewardDescription — plan excerpt', () => {
  it('puts the Plan section first and the rest of the brief after it', () => {
    const body = '# Brief\n\n## Goal\nA clean inbox.\n\n## Open questions\n- Which account?\n\n## Plan\n1. Unsubscribe.\n2. Archive.'
    const excerpt = excerptOf(buildStewardDescription({ project: project(body), digest, taskId: 't1', recentRows: [] }))
    expect(excerpt.startsWith('## Plan\n1. Unsubscribe.\n2. Archive.')).toBe(true)
    expect(excerpt).toContain('## Goal\nA clean inbox.')
    expect(excerpt.indexOf('## Plan')).toBeLessThan(excerpt.indexOf('# Brief'))
  })

  it('a body without a Plan section is excerpted as it is', () => {
    const body = '# Notes\n\nJust prose.'
    expect(excerptOf(buildStewardDescription({ project: project(body), digest, taskId: 't1', recentRows: [] }))).toBe(body)
  })

  it('the cap still bites, with its omission marker, after the plan has been read first', () => {
    const body = `# Brief\n\n## Goal\n${'g'.repeat(5_000)}\n\n## Plan\n${'p'.repeat(100)}`
    const excerpt = excerptOf(buildStewardDescription({ project: project(body), digest, taskId: 't1', recentRows: [] }))
    expect(excerpt.startsWith(`## Plan\n${'p'.repeat(100)}`)).toBe(true)
    expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(STEWARD_PLAN_EXCERPT_BYTES)
    expect(excerpt).toContain('plan truncated')
  })
})
