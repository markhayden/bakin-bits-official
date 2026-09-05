import { expect, test } from 'bun:test'
import { sessionOptions } from '../lib/session-options'

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
