/**
 * The project detail read validates what the server returns before the page
 * renders it. Every conversation row kind the server can store must pass, or
 * the whole project fails to load.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { ProjectApiError, readProjectDetail } from '../lib/project-api'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const project = (brainstormMessages: unknown[]) => ({
  id: 'p-1', title: 'Cafe spring launch', owner: 'main', body: '# Brief', created: '2026-11-14T09:00:00.000Z', updated: '2026-11-14T09:00:00.000Z',
  status: 'draft', progress: 0, tasks: [], assets: [], resolvedTasks: {}, resolvedAssets: [], brainstormMessages,
})
const serve = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ project: body }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('readProjectDetail', () => {
  test('a project whose conversation was carried over from a chat loads', async () => {
    const rows = [
      { kind: 'handoff', ts: '2026-11-14T10:00:00.000Z', handoffId: 'c-1:t1:p-1', direction: 'in', peers: [{ entity: 'chat:chat', id: 'c-1', title: 'Cafe launch' }], carried: 2 },
      { kind: 'user', ts: '2026-11-14T09:00:00.000Z', content: 'plan the launch' },
      { kind: 'assistant', ts: '2026-11-14T09:00:01.000Z', content: 'Project created.' },
    ]
    serve(project(rows))
    const loaded = await readProjectDetail('p-1', new AbortController().signal)
    expect(loaded.brainstormMessages).toEqual(rows as never)
  })

  test('every row kind the server stores is accepted', async () => {
    const kinds = ['user', 'assistant', 'tool', 'error', 'aborted', 'done', 'handoff']
    serve(project(kinds.map((kind) => ({ kind, ts: '2026-11-14T09:00:00.000Z' }))))
    expect((await readProjectDetail('p-1', new AbortController().signal)).brainstormMessages).toHaveLength(kinds.length)
  })

  test('a row of an unknown kind is still refused', async () => {
    serve(project([{ kind: 'mystery', ts: 't' }]))
    await expect(readProjectDetail('p-1', new AbortController().signal)).rejects.toBeInstanceOf(ProjectApiError)
  })
})
