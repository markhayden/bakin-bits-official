// @vitest-environment jsdom
/**
 * Project detail shell (D10): tabs with a stage default, the project
 * conversation full width on its tab and docked beside the others on
 * desktop, exactly ONE mounted composer in every tab/collapse/breakpoint
 * combination, no right rail; plus brainstorm durability (bakin#703) and the
 * Files tab's asset repair.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'

mock.module('../../../plugins/projects/components/project-checklist', () => ({
  ProjectChecklist: () => <div data-testid="project-checklist" />,
}))

mock.module('../../../plugins/projects/components/project-editor', () => ({
  ProjectEditor: ({ body }: { body: string }) => <div data-testid="project-editor">{body}</div>,
}))

import { ProjectDetail } from '../../../plugins/projects/components/project-detail'
import { emitPluginEvent } from '@makinbakin/sdk/hooks'

let desktop = true

beforeEach(() => {
  desktop = true
  ;(globalThis as unknown as { __bakinTestSdkHooks?: Record<string, unknown> }).__bakinTestSdkHooks = {
    useMediaQuery: () => desktop,
  }
})

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { fetch?: unknown }).fetch
  delete (globalThis as unknown as { __bakinTestSdkHooks?: unknown }).__bakinTestSdkHooks
})

function projectPayload(id: string, over: Record<string, unknown> = {}) {
  return {
    project: {
      id,
      title: 'Inbox cleanup',
      titleSource: 'agent',
      status: 'draft',
      owner: 'main',
      progress: 0,
      planRevision: 0,
      planSeenRevision: 0,
      tasks: [],
      assets: [],
      body: '# Inbox cleanup',
      created: '2026-05-01T00:00:00.000Z',
      updated: '2026-05-09T10:00:00.000Z',
      resolvedTasks: {},
      resolvedAssets: [],
      brainstormMessages: [],
      brainstormStreaming: false,
      ...over,
    },
  }
}

type Routes = Record<string, (init?: RequestInit) => unknown | Promise<unknown>>

function mockFetch(id: string, over: Record<string, unknown> = {}, routes: Routes = {}) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    if (routes[url]) return Response.json(await routes[url]!(init))
    if (url === `/api/plugins/projects/${id}`) return Response.json(projectPayload(id, over))
    if (url.endsWith('/history')) return Response.json({ history: [] })
    if (url.endsWith('/files')) return Response.json({ produced: [] })
    if (url.endsWith('/brainstorm/seen')) return Response.json({ ok: true })
    throw new Error(`Unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

const composers = () => screen.queryAllByTestId('chat-input')
const selectedTab = () => screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent

describe('ProjectDetail shell', () => {
  it('a draft opens on the Conversation tab with the transcript and one composer', async () => {
    mockFetch('p-draft', {
      brainstormMessages: [
        { kind: 'user', ts: '2026-05-09T10:00:01.000Z', content: 'What did we decide?' },
        { kind: 'assistant', ts: '2026-05-09T10:00:02.000Z', agentId: 'main', content: 'Keep the launch plan focused.' },
      ],
    })
    render(<ProjectDetail projectId="p-draft" onBack={() => {}} />)
    await screen.findByText('Keep the launch plan focused.')
    expect(selectedTab()).toBe('Conversation')
    expect(screen.getByRole('tablist', { name: 'Project sections' })).toBeDefined()
    expect(composers()).toHaveLength(1)
    // No docked copy while the conversation has the full width.
    expect(screen.queryByRole('complementary', { name: 'Project conversation' })).toBeNull()
  })

  it('opens on what matters at each stage', async () => {
    for (const [status, tab] of [['active', 'Steps'], ['completed', 'Files'], ['archived', 'Plan']] as const) {
      mockFetch(`p-${status}`, { status })
      render(<ProjectDetail projectId={`p-${status}`} onBack={() => {}} />)
      await screen.findByRole('tablist', { name: 'Project sections' })
      expect(selectedTab()).toBe(tab)
      cleanup()
    }
  })

  it('desktop: other tabs dock the conversation; collapsing unmounts it; exactly one composer throughout', async () => {
    mockFetch('p-dock', { status: 'active' })
    render(<ProjectDetail projectId="p-dock" onBack={() => {}} />)
    await screen.findByTestId('project-checklist')
    const dock = screen.getByRole('complementary', { name: 'Project conversation' })
    expect(within(dock).getAllByTestId('chat-input')).toHaveLength(1)
    expect(composers()).toHaveLength(1)

    await act(async () => { fireEvent.click(within(dock).getByRole('button', { name: 'Collapse project conversation' })) })
    expect(composers()).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Expand project conversation' })) })
    expect(composers()).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Conversation' })) })
    expect(screen.queryByRole('complementary', { name: 'Project conversation' })).toBeNull()
    expect(composers()).toHaveLength(1)
  })

  it('an unseen reply from before the visit marks a remembered-collapsed dock', async () => {
    ;(globalThis as unknown as { __bakinTestSdkHooks: Record<string, unknown> }).__bakinTestSdkHooks.useCollapsedAside = () => React.useState(true)
    mockFetch('p-unread', { status: 'active', brainstormUnread: true })
    render(<ProjectDetail projectId="p-unread" onBack={() => {}} />)
    await screen.findByTestId('project-checklist')
    expect(await screen.findByLabelText('Unread reply')).toBeDefined()
  })

  it('nothing is marked seen before the project loads (the tab default is only a guess until then)', async () => {
    ;(globalThis as unknown as { __bakinTestSdkHooks: Record<string, unknown> }).__bakinTestSdkHooks.useCollapsedAside = () => React.useState(true)
    mockFetch('p-early', { status: 'active', brainstormUnread: true })
    render(<ProjectDetail projectId="p-early" onBack={() => {}} />)
    await screen.findByTestId('project-checklist')
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => String(url))
    expect(calls.filter(url => url.endsWith('/brainstorm/seen'))).toEqual([])
  })

  it('mobile: no dock; an Ask button switches to the conversation', async () => {
    desktop = false
    mockFetch('p-mobile', { status: 'active' })
    render(<ProjectDetail projectId="p-mobile" onBack={() => {}} />)
    await screen.findByTestId('project-checklist')
    expect(screen.queryByRole('complementary', { name: 'Project conversation' })).toBeNull()
    expect(composers()).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask Main' })) })
    expect(selectedTab()).toBe('Conversation')
    expect(composers()).toHaveLength(1)
  })

  it('has no right rail, no resize divider and no status picker', async () => {
    mockFetch('p-plain', { status: 'active' })
    render(<ProjectDetail projectId="p-plain" onBack={() => {}} />)
    await screen.findByTestId('project-checklist')
    expect(screen.queryByText('Project information')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('Plan tab: Edit plan swaps in the editor with the plan body', async () => {
    mockFetch('p-plan', { status: 'archived', body: '# Plan body' })
    render(<ProjectDetail projectId="p-plan" onBack={() => {}} />)
    const edit = await screen.findByRole('button', { name: 'Edit plan' })
    await act(async () => { fireEvent.click(edit) })
    expect(screen.getByTestId('project-editor').textContent).toBe('# Plan body')
    expect(screen.getByRole('form', { name: 'Edit plan' })).toBeDefined()
  })
})

describe('Plan updated (D15)', () => {
  const agentRevision = {
    body: 'latest plan',
    planRevision: 3,
    planSeenRevision: 1,
    planUpdatedBy: 'agent',
    planUpdatedAt: '2026-10-25T10:00:00.000Z',
  }
  const history = {
    history: [
      { ts: '2026-10-25T09:00:00.000Z', author: 'agent', body: 'seen version', revision: 1 },
      { ts: '2026-10-25T09:30:00.000Z', author: 'agent', body: 'middle version', revision: 2 },
    ],
  }

  it('an unseen agent revision dots the Plan tab and shows the notice with the conversation', async () => {
    mockFetch('p-rev', agentRevision, { '/api/plugins/projects/p-rev/history': () => history })
    render(<ProjectDetail projectId="p-rev" onBack={() => {}} />)
    expect(await screen.findByText(/^Plan updated/)).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Plan updated' })).toBeDefined()
  })

  it('Review changes opens the Plan history against the last-seen revision and marks the new one seen', async () => {
    const seen: unknown[] = []
    mockFetch('p-review', agentRevision, {
      '/api/plugins/projects/p-review/history': () => history,
      '/api/plugins/projects/p-review/plan/seen': (init) => { seen.push(JSON.parse(String(init?.body))); return { ok: true, planSeenRevision: 3 } },
    })
    render(<ProjectDetail projectId="p-review" onBack={() => {}} />)
    const review = await screen.findByRole('button', { name: 'Review changes' })
    await act(async () => { fireEvent.click(review) })
    expect(selectedTab()).toMatch(/^Plan/)
    await waitFor(() => expect(seen).toEqual([{ revision: 3 }]))
    // The comparison baseline is the version the user last saw (revision 1).
    const diff = await screen.findByTestId('plan-history-diff')
    expect(within(diff).getByText('seen version')).toBeDefined()
    // The baseline is read BEFORE the revision is marked seen.
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => String(url))
    expect(calls.findIndex(url => url.endsWith('/history'))).toBeLessThan(calls.findIndex(url => url.endsWith('/plan/seen')))
  })

  it('the baseline holds for the whole visit while the lead keeps revising', async () => {
    const live = { ...agentRevision }
    const snapshots = [...history.history]
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/plugins/projects/p-hold') return Response.json(projectPayload('p-hold', live))
      if (url === '/api/plugins/projects/p-hold/history') return Response.json({ history: snapshots })
      if (url.endsWith('/plan/seen')) { live.planSeenRevision = live.planRevision; return Response.json({ ok: true }) }
      if (url.endsWith('/brainstorm/seen')) return Response.json({ ok: true })
      if (url.endsWith('/files')) return Response.json({ produced: [] })
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch
    render(<ProjectDetail projectId="p-hold" onBack={() => {}} />)
    const review = await screen.findByRole('button', { name: 'Review changes' })
    await act(async () => { fireEvent.click(review) })
    await within(await screen.findByTestId('plan-history-diff')).findByText('seen version')
    // Another agent revision lands while the user is still reviewing.
    snapshots.push({ ts: '2026-10-25T09:45:00.000Z', author: 'agent', body: 'latest plan', revision: 3 })
    Object.assign(live, { body: 'newest plan', planRevision: 4 })
    await act(async () => { emitPluginEvent({ event: 'projects.changed', projectId: 'p-hold' }) })
    await within(screen.getByTestId('plan-history-diff')).findByText('newest plan')
    expect(within(screen.getByTestId('plan-history-diff')).getByText('seen version')).toBeDefined()
  })

  it('a user\'s own revision raises nothing', async () => {
    mockFetch('p-own', { ...agentRevision, planUpdatedBy: 'user' })
    render(<ProjectDetail projectId="p-own" onBack={() => {}} />)
    await screen.findByRole('tablist', { name: 'Project sections' })
    expect(screen.queryByText(/^Plan updated/)).toBeNull()
    expect(screen.getByRole('tab', { name: 'Plan' })).toBeDefined()
  })
})

describe('ProjectDetail brainstorm durability (bakin#703)', () => {
  it('echoes the user message immediately on send — before the 202 lands', async () => {
    let resolvePost: () => void = () => {}
    const askBodies: unknown[] = []
    mockFetch('p-703', {}, {
      '/api/plugins/projects/p-703/ask': async (init) => {
        askBodies.push(JSON.parse(String(init?.body)))
        await new Promise<void>((resolve) => { resolvePost = resolve })
        return { ok: true, streaming: true }
      },
    })
    render(<ProjectDetail projectId="p-703" onBack={() => {}} />)
    const input = await screen.findByTestId('chat-input')
    fireEvent.change(input, { target: { value: 'What next?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('What next?')).toBeDefined())
    // The lead answers unless the user picked a one-off consult.
    expect(askBodies).toEqual([{ projectId: 'p-703', prompt: 'What next?', agent: 'main' }])
    await act(async () => { resolvePost() })
  })

  it('answering the lead\'s question card sends the formatted answer to the lead', async () => {
    const asks: unknown[] = []
    const question = { v: 1, id: 'q_0123456789abcdef', question: 'Which inbox?', options: [{ label: 'Personal' }, { label: 'Work' }], recommended: 0, allowOther: true }
    mockFetch('p-ask', {
      brainstormMessages: [
        { kind: 'user', ts: '2026-10-25T10:00:00.000Z', content: 'help me clean my inbox' },
        { kind: 'tool', ts: '2026-10-25T10:00:01.000Z', toolName: 'bakin_exec_ask_user', status: 'completed', metadata: { bakinQuestion: question } },
      ],
    }, { '/api/plugins/projects/p-ask/ask': (init) => { asks.push(JSON.parse(String(init?.body))); return { ok: true } } })
    render(<ProjectDetail projectId="p-ask" onBack={() => {}} />)
    const work = await screen.findByRole('button', { name: 'Work' })
    await act(async () => { fireEvent.click(work) })
    expect(asks).toEqual([{ projectId: 'p-ask', prompt: '**Which inbox?** → Work', agent: 'main' }])
  })

  it('rehydrates a mid-flight turn on mount and keeps streaming over the bus', async () => {
    mockFetch('p-live', {
      brainstormMessages: [
        { kind: 'user', ts: '2026-07-20T10:00:01.000Z', content: 'Long question' },
        { kind: 'assistant', ts: '2026-07-20T10:00:02.000Z', agentId: 'main', content: 'Partial reply so far' },
      ],
      brainstormStreaming: true,
    })
    render(<ProjectDetail projectId="p-live" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('Partial reply so far')).toBeDefined())
    act(() => {
      emitPluginEvent({ event: 'projects.brainstorm.chunk', projectId: 'p-live', chunk: { type: 'text', content: 'live continuation' } })
    })
    await waitFor(() => expect(screen.getByText(/live continuation/)).toBeDefined())
  })
})

describe('Files tab', () => {
  it('lists what the project\'s tasks produced apart from what is attached', async () => {
    mockFetch('p-produced', {
      status: 'completed',
      assets: [{ assetId: 'brief', label: 'Brief' }],
      resolvedAssets: [{ assetId: 'brief', label: 'Brief', type: 'text' }],
    }, {
      '/api/plugins/projects/p-produced/files': () => ({
        produced: [
          { assetId: 'hero', type: 'images', description: 'Hero image', taskId: 'board-a' },
          { assetId: 'brief', type: 'text', description: 'Brief', taskId: 'board-a' },
        ],
      }),
    })
    render(<ProjectDetail projectId="p-produced" onBack={() => {}} />)
    const produced = await screen.findByRole('list', { name: 'Produced files' })
    expect(within(produced).getByText('Hero image')).toBeDefined()
    // Already attached ⇒ listed once, under Attached.
    expect(within(produced).queryByText('Brief')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Attached files' })).getByText('Brief')).toBeDefined()
  })


  it('previews a non-image file without an image and links to the asset', async () => {
    mockFetch('p-files', {
      status: 'completed',
      assets: [{ assetId: '20260531-brief-abc12345', label: 'Launch brief' }],
      resolvedAssets: [{ assetId: '20260531-brief-abc12345', label: 'Launch brief', type: 'pdf', description: 'Campaign planning PDF' }],
    })
    render(<ProjectDetail projectId="p-files" onBack={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Launch brief' }))
    const dialog = await screen.findByRole('dialog', { name: /Launch brief/ })
    expect(within(dialog).queryByRole('img')).toBeNull()
    expect(within(dialog).getByRole('link', { name: 'Open asset' }).getAttribute('href')).toBe('/assets/20260531-brief-abc12345')
  })

  it('produced files reload when the project signals a board change', async () => {
    let filesCalls = 0
    mockFetch('p-reload', { status: 'completed' }, { '/api/plugins/projects/p-reload/files': () => { filesCalls++; return { produced: [] } } })
    render(<ProjectDetail projectId="p-reload" onBack={() => {}} />)
    await screen.findByText('Nothing produced yet')
    const before = filesCalls
    await act(async () => { emitPluginEvent({ event: 'projects.changed', projectId: 'p-reload', action: 'task.statusChanged' }) })
    await waitFor(() => expect(filesCalls).toBeGreaterThan(before))
  })

  it('offers relink and detach for a missing file', async () => {
    mockFetch('p-missing', {
      status: 'completed',
      assets: [{ assetId: 'deleted-image.png', label: 'Deleted image' }],
      resolvedAssets: [{ assetId: 'deleted-image.png', label: 'Deleted image', type: 'unknown', missing: true }],
    }, {
      '/api/plugins/assets/versioned': () => ({ assets: [{ assetId: '20260531-replacement-abc12345', type: 'images', description: 'Replacement image' }] }),
    })
    render(<ProjectDetail projectId="p-missing" onBack={() => {}} />)
    expect(await screen.findByText("can't find asset")).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Relink Deleted image' }))
    expect(await screen.findByText('20260531-replacement-abc12345')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Detach Deleted image' }))
    expect(await screen.findByRole('dialog', { name: 'Detach file?' })).toBeDefined()
    expect(screen.getByText(/Bakin can't find this file/)).toBeDefined()
  })
})
