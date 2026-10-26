/**
 * Steward tools + the input gate (D24, D24a, D25) through the activated
 * plugin: identity, attribution, out-of-turn appends, and the
 * waitingOn → replyPending → cleared lifecycle around /ask.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RuntimeChatChunk, RuntimeMessageArgs } from '@makinbakin/sdk/types'
import { parseBakinQuestion } from '@makinbakin/sdk/utils'
import projectsPlugin from '../index'
import { createProjectRepository, type ProjectRepository } from '../lib/parser'
import { stewardEligibility } from '../lib/steward/scan'
import { activatePlugin, callRoute, callTool, findRoute, findTool, MarkdownStorageAdapter, type ActivatedPlugin } from '../test-helpers'
import type { Project } from '../types'

const root = join(tmpdir(), `projects-steward-tools-${Date.now()}`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const testGlobal = globalThis as typeof globalThis & { __bakinProjectIndex?: unknown; __bakinProjectLock?: unknown }
const OPERATOR = { 'X-Bakin-Operator': 'declared' }
const STEWARD_TASK = 'task-steward-1'

let plugin: ActivatedPlugin
let repo: ProjectRepository
let dir: string
let n = 0
let appended: Array<Record<string, unknown>>

async function waitUntil(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function project(extra: Partial<Project> = {}): Project {
  return {
    id: 'p1', title: 'Launch', titleSource: 'user', status: 'active',
    created: '2026-10-20T00:00:00.000Z', updated: '2026-10-25T00:00:00.000Z',
    owner: 'pixel', tasks: [], assets: [], planRevision: 1, body: 'Plan', progress: 0,
    steward: { openTaskId: STEWARD_TASK, phase: 'created', frozen: { title: 'Check in: Launch', assignee: 'pixel', description: 'brief' } },
    ...extra,
  }
}

async function setup(extra: Partial<Project> = {}): Promise<void> {
  testGlobal.__bakinProjectIndex = undefined
  testGlobal.__bakinProjectLock = undefined
  dir = join(root, `case-${++n}`)
  repo = createProjectRepository(new MarkdownStorageAdapter(dir))
  repo.writeProject(project(extra))
  plugin = await activatePlugin(projectsPlugin, dir)
  appended = []
  plugin.ctx.events.on('projects.brainstorm.appended', (_e, data) => { appended.push(data) })
  await plugin.ctx.tasks.create({
    id: STEWARD_TASK, title: 'Check in: Launch', agent: 'pixel', projectId: 'p1',
    source: { pluginId: 'projects', entityType: 'steward', entityId: 'p1' },
  })
}

const tool = (name: string) => findTool(plugin.execTools, name)!
/** Tool calls come from the check-in's assignee unless a test says otherwise. */
const asSteward = (t: Parameters<typeof callTool>[0], params: Record<string, unknown>, agent = 'pixel') => callTool(t, params, agent)
const rows = () => repo.readBrainstormMessages('p1')
const read = () => repo.readProject('p1')!

/** A brainstorm turn held open until released. */
function holdTurns(): { release: () => void; contents: string[] } {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const contents: string[] = []
  plugin.ctx.runtime.messaging.stream = ((args: RuntimeMessageArgs) => (async function* (): AsyncIterable<RuntimeChatChunk> {
    contents.push(args.content)
    // Like a real runtime, an abort ends the stream.
    await Promise.race([gate, new Promise(resolve => args.signal?.addEventListener('abort', resolve))])
    if (args.signal?.aborted) return
    yield { type: 'text', content: 'On it.' }
    yield { type: 'done' }
  })()) as typeof plugin.ctx.runtime.messaging.stream
  return { release, contents }
}

async function ask(prompt: string) {
  return callRoute(findRoute(plugin.routes, 'POST', '/:projectId/ask')!, plugin.ctx, {
    path: '/p1/ask', searchParams: { projectId: 'p1' }, body: { prompt }, headers: OPERATOR,
  })
}

const question = {
  projectId: 'p1', taskId: STEWARD_TASK,
  question: 'Drop the blog post from scope?',
  options: [{ label: 'Drop it' }, { label: 'Keep it' }],
  recommended: 0,
  context: 'The copy step is blocked on the blog brief, which nobody owns.',
}

describe('steward identity', () => {
  beforeEach(() => setup())

  it('refuses any taskId but the open check-in', async () => {
    const result = await asSteward(tool('bakin_exec_projects_checkin'), { projectId: 'p1', taskId: 'task-other', summary: 'hi' })
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'not_steward' }))
    expect(rows()).toEqual([])
  })

  it('points a call from inside the project conversation at ask_user — even with the open check-in\'s task id', async () => {
    const turn = holdTurns()
    expect((await ask('hello')).status).toBe(202)
    // The brainstorm turn runs as `main`; it learned the check-in's id somehow.
    const result = await asSteward(tool('bakin_exec_projects_request_input'), question, 'main')
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'use_ask_user' }))
    expect(read().waitingOn).toBeUndefined()
    turn.release()
  })

  it('refuses another agent holding the open check-in\'s task id', async () => {
    const result = await asSteward(tool('bakin_exec_projects_checkin'), { projectId: 'p1', taskId: STEWARD_TASK, summary: 'hi' }, 'scribe')
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'not_steward' }))
    expect(rows()).toEqual([])
  })

  it('refuses a check-in task that is not this project\'s steward', async () => {
    await plugin.ctx.tasks.update(STEWARD_TASK, { source: { pluginId: 'projects', entityType: 'checklist', entityId: 'p1:x' } })
    const result = await asSteward(tool('bakin_exec_projects_checkin'), { projectId: 'p1', taskId: STEWARD_TASK, summary: 'hi' })
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'not_steward' }))
  })
})

describe('checkin', () => {
  beforeEach(() => setup())

  it('appends an attributed row on its own steward turn — the frozen assignee, not the current lead', async () => {
    repo.writeProject({ ...read(), owner: 'scribe' })
    const result = await asSteward(tool('bakin_exec_projects_checkin'), {
      projectId: 'p1', taskId: STEWARD_TASK, summary: 'Sent 2 steps to the board', actions: ['Promoted t001', 'Assigned t002 to scribe'],
    })
    expect(result).toEqual({ ok: true, status: 'appended' })
    expect(rows()).toEqual([expect.objectContaining({
      kind: 'assistant',
      turnId: `steward:${STEWARD_TASK}`,
      agentId: 'pixel',
      content: 'Checked in: Sent 2 steps to the board\n- Promoted t001\n- Assigned t002 to scribe',
    })])
    expect(appended).toEqual([{ projectId: 'p1' }])
  })

  it('queues behind a running brainstorm turn and lands after it', async () => {
    const turn = holdTurns()
    await ask('hello')
    const result = await asSteward(tool('bakin_exec_projects_checkin'), { projectId: 'p1', taskId: STEWARD_TASK, summary: 'Checked' })
    expect(result).toEqual({ ok: true, status: 'queued' })
    expect(rows().some(r => r.kind === 'assistant' && r.content.startsWith('Checked in'))).toBe(false)
    turn.release()
    await waitUntil(() => rows().some(r => r.kind === 'assistant' && r.content.startsWith('Checked in')), 'queued check-in')
    const kinds = rows().map(r => r.kind === 'assistant' ? r.content : r.kind)
    expect(kinds.indexOf('Checked in: Checked')).toBeGreaterThan(kinds.indexOf('On it.'))
  })
})

describe('request_input', () => {
  beforeEach(() => setup())

  it('posts an answerable card, opens the gate, announces it and pauses scans', async () => {
    const result = await asSteward(tool('bakin_exec_projects_request_input'), question)
    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'appended', questionId: expect.stringMatching(/^q_[a-z0-9]{16}$/) }))
    const row = rows()[0]!
    expect(row).toEqual(expect.objectContaining({ kind: 'tool', turnId: `steward:${STEWARD_TASK}`, agentId: 'pixel', status: 'completed' }))
    const card = parseBakinQuestion(row.kind === 'tool' ? row.metadata?.bakinQuestion : null)
    expect(card).toEqual(expect.objectContaining({ id: result.questionId, question: question.question, recommended: 0, allowOther: true }))
    expect(read().waitingOn).toEqual(expect.objectContaining({
      kind: 'input', questionId: result.questionId, question: question.question, options: ['Drop it', 'Keep it'], context: question.context,
    }))
    expect(appended).toEqual([{ projectId: 'p1', notice: { agentId: 'pixel', preview: question.question } }])
    expect(stewardEligibility(read())).toBe('waiting_on_user')
  })

  it('rejects an invalid question without touching the gate', async () => {
    const result = await asSteward(tool('bakin_exec_projects_request_input'), { ...question, options: [{ label: 'Only one' }] })
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'invalid_question' }))
    expect(read().waitingOn).toBeUndefined()
    expect(rows()).toEqual([])
  })

  it('a newer question supersedes the open one', async () => {
    const first = await asSteward(tool('bakin_exec_projects_request_input'), question)
    const second = await asSteward(tool('bakin_exec_projects_request_input'), { ...question, question: 'Push the launch a week?' })
    expect(second.questionId).not.toBe(first.questionId)
    expect(read().waitingOn?.questionId).toBe(second.questionId)
  })
})

describe('the reply turn', () => {
  beforeEach(() => setup())

  it('carries the pending question, flips to replyPending once admitted, and clears at settle', async () => {
    const { questionId } = await asSteward(tool('bakin_exec_projects_request_input'), question)
    const turn = holdTurns()
    expect((await ask('**Drop the blog post from scope?** → Drop it')).status).toBe(202)
    expect(turn.contents[0]).toContain('Pending question from your last check-in: Drop the blog post from scope?')
    expect(turn.contents[0]).toContain(`Why you asked: ${question.context}`)
    expect(read().waitingOn).toBeUndefined()
    expect(read().replyPending).toEqual({ questionId })
    expect(stewardEligibility(read())).toBe('waiting_on_user')
    turn.release()
    await waitUntil(() => read().replyPending === undefined, 'reply gate cleared')
    expect(stewardEligibility(read())).toBe('run_open')
  })

  it('a busy engine leaves the gate untouched', async () => {
    const first = holdTurns()
    await ask('something first')
    await asSteward(tool('bakin_exec_projects_request_input'), question)
    expect((await ask('my reply')).status).toBe(409)
    expect(read().waitingOn).toBeDefined()
    expect(read().replyPending).toBeUndefined()
    first.release()
  })

  it('an aborted reply turn ends the gate too', async () => {
    await asSteward(tool('bakin_exec_projects_request_input'), question)
    holdTurns()
    await ask('my reply')
    expect(read().replyPending).toBeDefined()
    const abort = await callRoute(findRoute(plugin.routes, 'POST', '/:projectId/ask/abort')!, plugin.ctx, { path: '/p1/ask/abort', searchParams: { projectId: 'p1' }, headers: OPERATOR })
    expect(abort.status).toBe(200)
    await waitUntil(() => read().replyPending === undefined, 'gate cleared after abort')
    expect(rows().some(r => r.kind === 'aborted')).toBe(true)
  })
})

describe('boot sweep', () => {
  it('clears a reply gate no turn is alive to finish', async () => {
    await setup({ replyPending: { questionId: 'q_0000000000000000' } })
    await waitUntil(() => read().replyPending === undefined, 'boot sweep')
  })
})

describe('review round 1 regressions', () => {
  beforeEach(() => setup())

  it('a question posted while /ask reads the board still rides that reply', async () => {
    const realList = plugin.ctx.tasks.list
    let posted = false
    plugin.ctx.tasks.list = async (filter) => {
      if (!posted) {
        posted = true
        await asSteward(tool('bakin_exec_projects_request_input'), question)
      }
      return realList(filter)
    }
    const turn = holdTurns()
    expect((await ask('Drop it')).status).toBe(202)
    expect(turn.contents[0]).toContain('Pending question from your last check-in')
    expect(read().waitingOn).toBeUndefined()
    expect(read().replyPending).toBeDefined()
    turn.release()
  })

  it('a card that fails to land withdraws its gate — immediately', async () => {
    const realWrite = plugin.ctx.storage.write.bind(plugin.ctx.storage)
    plugin.ctx.storage.write = (path: string, content: string) => {
      if (path.endsWith('.brainstorm.json')) throw new Error('disk full')
      return realWrite(path, content)
    }
    const result = await asSteward(tool('bakin_exec_projects_request_input'), question)
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'append_failed' }))
    expect(read().waitingOn).toBeUndefined()
  })

  it('a card that fails to land withdraws its gate — after a queued flush', async () => {
    const turn = holdTurns()
    await ask('hello')
    const result = await asSteward(tool('bakin_exec_projects_request_input'), question)
    expect(result.status).toBe('queued')
    expect(read().waitingOn).toBeDefined()
    const realWrite = plugin.ctx.storage.write.bind(plugin.ctx.storage)
    plugin.ctx.storage.write = (path: string, content: string) => {
      if (path.endsWith('.brainstorm.json')) throw new Error('disk full')
      return realWrite(path, content)
    }
    turn.release()
    await waitUntil(() => read().waitingOn === undefined, 'gate withdrawn')
  })
})

describe('review round 2 regressions', () => {
  it('boot withdraws a question whose card never reached the transcript', async () => {
    await setup({ waitingOn: { kind: 'input', questionId: 'q_aaaaaaaaaaaaaaaa', question: 'Lost?', since: '2026-10-26T00:00:00Z' } })
    await waitUntil(() => read().waitingOn === undefined, 'lost question withdrawn')
  })

  it('a card landing while the engine admits the reply is ended by that reply', async () => {
    await setup()
    const realList = plugin.ctx.runtime.agents.list
    let calls = 0
    plugin.ctx.runtime.agents.list = (async () => {
      // Call 1 is /ask choosing the agent (before the question is sampled);
      // call 2 is the engine's resolveThread at admission — after it.
      if (++calls === 2) await asSteward(tool('bakin_exec_projects_request_input'), question)
      return realList()
    }) as typeof plugin.ctx.runtime.agents.list
    const turn = holdTurns()
    expect((await ask('my reply')).status).toBe(202)
    expect(read().waitingOn).toBeUndefined()
    expect(read().replyPending).toBeDefined()
    turn.release()
    await waitUntil(() => read().replyPending === undefined, 'gate cleared')
  })
})
