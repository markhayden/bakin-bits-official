/**
 * Projects — conversation consolidation backlog (bakin#706):
 * transcript row cap, mtime-cached attention timestamps, the
 * interrupted-turn boot sweep, and the mid-turn streamed-text preview.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { activatePlugin, findRoute, callRoute, MarkdownStorageAdapter } from '../test-helpers'
import type { ActivatedPlugin } from '../test-helpers'
import type { RuntimeChatChunk as ChatChunk, RuntimeMessageArgs as MessageArgs } from '@makinbakin/sdk/types'

const testDir = join(tmpdir(), `bakin-test-projects-706-${Date.now()}`)
const projectsDir = join(testDir, 'projects')

// Isolation: activatePlugin(testDir) hands the plugin a storage adapter
// rooted at the temp dir; env vars + the content-dir mock keep any
// transitively-imported bakin core honest.
process.env.BAKIN_HOME = testDir
process.env.OPENCLAW_HOME = testDir + '-openclaw'

mock.module('@bakin/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({ projects: testDir }),
}))

const testGlobal = globalThis as typeof globalThis & {
  __bakinBroadcast?: unknown
  __bakinProjectIndex?: unknown
  __bakinProjectLock?: unknown
}
testGlobal.__bakinBroadcast = mock()

// Dynamic require — defers the plugin load until after mocks are set.
const projectsPlugin = require('../../../plugins/projects/index').default as typeof import('../../../plugins/projects/index').default
import {
  createProjectRepository,
  BRAINSTORM_ROW_CAP,
  type ProjectBrainstormMessage,
} from '../../../plugins/projects/lib/parser'

function writeProjectFixture(id: string, title = `Project ${id}`) {
  const now = new Date().toISOString()
  const fm = { id, title, status: 'active', created: now, updated: now, owner: 'main', tasks: [] }
  mkdirSync(projectsDir, { recursive: true })
  writeFileSync(join(projectsDir, `${id}.md`), `---\n${yaml.dump(fm, { lineWidth: -1 }).trim()}\n---\n\n# ${title}\n`, 'utf-8')
}

function writeBrainstormFixture(id: string, rows: Array<Record<string, unknown>>) {
  mkdirSync(projectsDir, { recursive: true })
  writeFileSync(join(projectsDir, `${id}.brainstorm.json`), JSON.stringify(rows, null, 2), 'utf-8')
}

function userRow(content: string, ts = new Date().toISOString()): Record<string, unknown> {
  return { kind: 'user', ts, content }
}

function assistantRow(content: string, ts = new Date().toISOString()): Record<string, unknown> {
  return { kind: 'assistant', ts, content }
}

let plugin: ActivatedPlugin

beforeEach(async () => {
  testGlobal.__bakinProjectIndex = undefined
  testGlobal.__bakinProjectLock = undefined
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  mkdirSync(projectsDir, { recursive: true })
  plugin = await activatePlugin(projectsPlugin, testDir)
})

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
})

describe('transcript row cap', () => {
  it('writeBrainstormMessages keeps only the newest BRAINSTORM_ROW_CAP rows', () => {
    const repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
    const rows = Array.from({ length: BRAINSTORM_ROW_CAP + 25 }, (_, i) =>
      ({ kind: 'user', ts: new Date(i).toISOString(), content: `row ${i}` }) as ProjectBrainstormMessage)
    repo.writeBrainstormMessages('capped', rows)
    const kept = repo.readBrainstormMessages('capped')
    expect(kept.length).toBe(BRAINSTORM_ROW_CAP)
    // Oldest dropped, newest kept.
    expect((kept[0] as { content: string }).content).toBe('row 25')
    expect((kept[kept.length - 1] as { content: string }).content).toBe(`row ${BRAINSTORM_ROW_CAP + 24}`)
  })
})

describe('mtime-cached last agent activity', () => {
  it('caches per sidecar mtime+size and invalidates on write', () => {
    const repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
    repo.writeBrainstormMessages('p1', [
      userRow('hi', '2026-01-01T00:00:00.000Z') as ProjectBrainstormMessage,
      assistantRow('hello', '2026-01-01T00:00:01.000Z') as ProjectBrainstormMessage,
    ])
    expect(repo.readLastAgentActivityTs('p1')).toBe('2026-01-01T00:00:01.000Z')
    // Cached read returns the same answer without a content change.
    expect(repo.readLastAgentActivityTs('p1')).toBe('2026-01-01T00:00:01.000Z')
    // A new agent row (different size → cache miss) updates the answer.
    repo.writeBrainstormMessages('p1', [
      userRow('hi', '2026-01-01T00:00:00.000Z') as ProjectBrainstormMessage,
      assistantRow('hello', '2026-01-01T00:00:01.000Z') as ProjectBrainstormMessage,
      assistantRow('more thoughts here', '2026-01-02T00:00:00.000Z') as ProjectBrainstormMessage,
    ])
    expect(repo.readLastAgentActivityTs('p1')).toBe('2026-01-02T00:00:00.000Z')
  })

  it('returns null when the sidecar is missing or has no agent rows', () => {
    const repo = createProjectRepository(new MarkdownStorageAdapter(testDir))
    expect(repo.readLastAgentActivityTs('nope')).toBeNull()
    repo.writeBrainstormMessages('only-user', [userRow('hi') as ProjectBrainstormMessage])
    expect(repo.readLastAgentActivityTs('only-user')).toBeNull()
  })
})

describe('interrupted-turn boot sweep', () => {
  it('stamps an error row on transcripts that end on a user row; leaves settled ones alone', async () => {
    writeProjectFixture('interrupted')
    writeBrainstormFixture('interrupted', [userRow('are you there?')])
    writeProjectFixture('settled')
    writeBrainstormFixture('settled', [userRow('hi'), assistantRow('hello')])

    // The sweep runs during activate — re-activate over the fixtures.
    plugin = await activatePlugin(projectsPlugin, testDir)

    const interrupted = JSON.parse(readFileSync(join(projectsDir, 'interrupted.brainstorm.json'), 'utf-8')) as Array<Record<string, unknown>>
    expect(interrupted.length).toBe(2)
    expect(interrupted[1]).toMatchObject({
      kind: 'error',
      message: 'Interrupted by a server restart before the reply finished.',
    })

    const settled = JSON.parse(readFileSync(join(projectsDir, 'settled.brainstorm.json'), 'utf-8')) as Array<Record<string, unknown>>
    expect(settled.length).toBe(2)

    // Idempotent: a second activate doesn't stack more error rows.
    plugin = await activatePlugin(projectsPlugin, testDir)
    const again = JSON.parse(readFileSync(join(projectsDir, 'interrupted.brainstorm.json'), 'utf-8')) as Array<Record<string, unknown>>
    expect(again.length).toBe(2)
  })
})

describe('started attention event (bakin#707)', () => {
  it('emits projects.brainstorm.started at accept, before any chunk', async () => {
    writeProjectFixture('startle')
    const events: string[] = []
    const off = plugin.ctx.events.on('*', (event) => {
      if (event.startsWith('projects.brainstorm.')) events.push(event)
    })
    const settled = new Promise<void>((resolve) => {
      const offDone = plugin.ctx.events.on('*', (event) => {
        if (event === 'projects.brainstorm.done' || event === 'projects.brainstorm.error') {
          offDone()
          resolve()
        }
      })
    })
    plugin.ctx.runtime.messaging.stream = mock(() => (async function* (): AsyncIterable<ChatChunk> {
      yield { type: 'text', content: 'ok' }
    })()) as typeof plugin.ctx.runtime.messaging.stream

    const askRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
    const { response } = await callRoute(askRoute, plugin.ctx, {
      body: { projectId: 'startle', prompt: 'go' },
      rawResponse: true,
    })
    expect(response.status).toBe(202)
    // started is out at accept — chunks may not have arrived yet.
    expect(events[0]).toBe('projects.brainstorm.started')
    await settled
    off()
    expect(events).toEqual([
      'projects.brainstorm.started',
      'projects.brainstorm.chunk',
      'projects.brainstorm.done',
    ])
  })
})

describe('mid-turn streamed-text preview', () => {
  it('GET /:projectId carries brainstormStreamingText while a turn is in flight, and drops it after', async () => {
    writeProjectFixture('previewed')
    let releaseTurn!: () => void
    const gate = new Promise<void>((resolve) => { releaseTurn = resolve })
    plugin.ctx.runtime.messaging.stream = mock((args: MessageArgs) => {
      void args
      return (async function* (): AsyncIterable<ChatChunk> {
        yield { type: 'text', content: 'Working on ' }
        await gate
        yield { type: 'text', content: 'it.' }
      })()
    }) as typeof plugin.ctx.runtime.messaging.stream

    const settled = new Promise<void>((resolve) => {
      const off = plugin.ctx.events.on('*', (event) => {
        if (event === 'projects.brainstorm.done' || event === 'projects.brainstorm.error') {
          off()
          resolve()
        }
      })
    })

    const askRoute = findRoute(plugin.routes, 'POST', '/:projectId/ask')!
    const { response } = await callRoute(askRoute, plugin.ctx, {
      body: { projectId: 'previewed', prompt: 'go' },
      rawResponse: true,
    })
    expect(response.status).toBe(202)

    // Poll until the first chunk has landed in the in-flight preview.
    const getRoute = findRoute(plugin.routes, 'GET', '/:projectId')!
    let midTurn: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      const { body } = await callRoute(getRoute, plugin.ctx, { searchParams: { projectId: 'previewed' } })
      midTurn = body.project as Record<string, unknown>
      if (midTurn.brainstormStreamingText === 'Working on ') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(midTurn.brainstormStreaming).toBe(true)
    expect(midTurn.brainstormStreamingText).toBe('Working on ')

    releaseTurn()
    await settled
    // The done event lands before the engine releases the slot — poll until
    // the in-flight registration is gone.
    let after: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      const { body } = await callRoute(getRoute, plugin.ctx, { searchParams: { projectId: 'previewed' } })
      after = body.project as Record<string, unknown>
      if (after.brainstormStreaming === false) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(after.brainstormStreaming).toBe(false)
    expect('brainstormStreamingText' in after).toBe(false)
  })
})
