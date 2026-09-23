import type { ProjectDetailData } from '../types'

export const plan = '# Weekend plan\n\n## Goal\n\nPlan a short walk and photograph the river.\n\n## Route\n\n- River trail\n- Visitor center'
export function detailFixtureProject(id = 'sample'): ProjectDetailData {
  return {
    id, title: id === 'sample' ? 'Weekend photography plan' : 'Another project', status: 'draft', owner: 'main', progress: 50,
    tasks: [
      { id: 't001', instanceId: '00000000-0000-4000-8000-000000000101', title: 'Prepare camera gear', description: 'Charge batteries', checked: true },
      { id: 't002', instanceId: '00000000-0000-4000-8000-000000000102', title: 'Confirm walking route', description: 'Check weather', checked: false },
    ],
    assets: [], resolvedTasks: {}, resolvedAssets: [], body: plan,
    created: '2026-01-12T10:00:00Z', updated: '2026-01-15T10:00:00Z', brainstormMessages: [],
  }
}
export function createDetailFixtureState() {
  return {
    project: detailFixtureProject(),
    other: detailFixtureProject('other'),
    history: [{ ts: '2026-01-14T10:00:00Z', author: 'agent', body: plan.replace('and photograph the river.', 'along the river.') }],
    failures: {} as Record<string, number>,
    requests: [] as { method: string; path: string; body: Record<string, any> }[],
    receipts: {} as Record<string, string>,
    loseAddReply: false,
  }
}
export type DetailFixtureState = ReturnType<typeof createDetailFixtureState>
export function detailFixtureFetch(state: DetailFixtureState, fallback: typeof fetch, changed: () => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (!path.startsWith('/api/plugins/projects/')) return fallback(input, init)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const key = `${method} ${path}`
    state.requests.push({ method, path, body })
    if (state.failures[key]) { state.failures[key]--; return Response.json({ error: 'Synthetic request failure' }, { status: 503 }) }
    if (path.endsWith('/brainstorm/seen')) return Response.json({ ok: true })
    if (path.endsWith('/ask')) return Response.json({ ok: true }, { status: 202 })
    if (path.endsWith('/history')) return Response.json({ history: state.history })
    if (path.endsWith('/history/0/restore')) { state.project.body = state.history[0]!.body; changed(); return Response.json({ ok: true }) }
    const project = path.includes('/other') ? state.other : state.project
    if (method === 'GET' && /^\/api\/plugins\/projects\/[^/]+$/.test(path)) return Response.json({ project })
    if (method === 'PUT' && path.endsWith(`/${project.id}`)) {
      const { expected, ...patch } = body
      const conflicts: Record<string, unknown> = {}
      for (const field of Object.keys(patch)) {
        const current = project[field as keyof ProjectDetailData]
        if (expected && current !== expected[field] && current !== patch[field]) conflicts[field] = { current, expected: expected[field], requested: patch[field] }
      }
      if (Object.keys(conflicts).length) return Response.json({ error: 'Overlapping edits', conflicts }, { status: 409 })
      Object.assign(project, patch); changed(); return Response.json({ ok: true })
    }
    if (method === 'POST' && path.endsWith('/checklist')) {
      const old = state.receipts[body.requestId]
      if (old) return Response.json({ ok: true, taskItemId: old, deleted: !project.tasks.some(item => item.id === old) })
      const taskItemId = `t${project.tasks.length + 1}`
      project.tasks.push({ id: taskItemId, instanceId: crypto.randomUUID(), title: body.title, checked: false })
      state.receipts[body.requestId] = taskItemId
      changed()
      if (state.loseAddReply) { state.loseAddReply = false; throw new Error('Synthetic lost add response') }
      return Response.json({ ok: true, taskItemId })
    }
    const match = path.match(/\/checklist\/([^/]+)(?:\/(toggle|promote))?$/)
    if (match) {
      const item = project.tasks.find(task => task.id === match[1])
      if (!item) return Response.json({ error: 'Item removed' }, { status: 404 })
      if (method === 'DELETE') project.tasks = project.tasks.filter(task => task !== item)
      else if (match[2] === 'toggle') item.checked = body.checked
      else if (match[2] === 'promote') item.taskId = 'board-task'
      else if (body.expected && body.expected.description !== (item.description ?? '') && body.description !== item.description) return Response.json({ error: 'Description changed', conflicts: { description: { current: item.description ?? '' } } }, { status: 409 })
      else item.description = body.description
      project.progress = Math.round(100 * project.tasks.filter(task => task.checked).length / Math.max(1, project.tasks.length))
      changed(); return Response.json({ ok: true, taskId: item.taskId })
    }
    return fallback(input, init)
  }) as typeof fetch
}
