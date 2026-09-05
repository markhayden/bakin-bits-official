import { expect, test } from 'bun:test'
import { sessionOptions } from '../lib/session-options'
import type { Session } from '../lib/contracts'

test('populates named agents without granting access and excludes completed task suggestions', async () => {
  const result = await sessionOptions({
    runtime: { agents: { list: async () => [
      { id: 'patch', name: 'Patch', metadata: { workspacePath: '/tmp' } },
      { id: 'chef', name: 'Chef', metadata: { workspace: '/missing-terminal-workspace' } },
    ] } },
    tasks: { list: async () => [
      { id: 'active', title: 'Build Terminal', column: 'inProgress', agent: 'patch', projectId: 'bakin' },
      { id: 'done', title: 'Done', column: 'done' },
    ] },
    getSettings: () => ({ enabledAgents: [{ id: 'patch' }] }),
  } as unknown as Parameters<typeof sessionOptions>[0], [], '/tmp')
  expect(result.agents).toEqual([
    { id: 'chef', name: 'Chef', enabled: false },
    { id: 'patch', name: 'Patch', enabled: true, workspace: '/tmp' },
  ])
  expect(result.defaults).toEqual({ cwd: '/tmp', agentId: 'patch' })
  expect(result.tasks).toEqual([{ id: 'active', title: 'Build Terminal', agentId: 'patch', projectId: 'bakin' }])
})

test('ignores managed or missing directories and never defaults to a disabled agent', async () => {
  const context = {
    runtime: { agents: { list: async () => [{ id: 'patch', name: 'Patch' }] } },
    tasks: { list: async () => [] }, getSettings: () => ({}),
  } as unknown as Parameters<typeof sessionOptions>[0]
  const recent = [
    { createdAt: 3, cwd: '/tmp', worktreePath: '/tmp', agentId: 'patch' },
    { createdAt: 2, cwd: '/missing-terminal-workspace', agentId: 'patch' },
    { createdAt: 1, cwd: '/tmp', agentId: 'patch' },
  ] as Session[]
  const result = await sessionOptions(context, recent, '/')
  expect(result.defaults).toEqual({ cwd: '/tmp', agentId: '' })
  expect(result.agents[0].enabled).toBe(false)
  expect((await sessionOptions(context, recent.slice(0, 2), '/')).defaults.cwd).toBe('/')
})
