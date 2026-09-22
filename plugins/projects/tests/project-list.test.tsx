// @vitest-environment jsdom

/**
 * ProjectList component smoke — verifies the projects list page renders,
 * fetches the project list, integrates with the mocked useSearch hook,
 * filters/reorders by score when results return, and falls back to a
 * local substring filter when useSearch is empty.
 *
 * Per CLAUDE.md test rules, every filesystem-touching module is mocked to
 * a temp directory even though this is a pure component test — defensive
 * isolation prevents accidental ~/.bakin/ writes.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { emitPluginEvent } from '@makinbakin/sdk/hooks'

// ---------------------------------------------------------------------------
// Mandatory CLAUDE.md test mocks
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `bakin-test-projects-search-${Date.now()}`)
mkdirSync(testDir, { recursive: true })

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
}))

mock.module('@/core/content-dir', () => ({
  getContentDir: () => testDir,
  getBakinPaths: () => ({}),
}))

mock.module('@/core/logger', () => ({
  createLogger: () => ({
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  }),
}))

mock.module('@/core/watcher', () => ({
  registerSyncHook: mock(),
  registerUnlinkHook: mock(),
}))

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Stubs for client-only integrations
// ---------------------------------------------------------------------------

// useQueryState: simple controllable [value, setter] pair per key.
const queryState: Record<string, string> = {}
const querySetters: Record<string, (v: string) => void> = {}

function setQueryStateValue(key: string, value: string) {
  queryState[key] = value
  querySetters[key]?.(value)
}

mock.module('@/hooks/use-query-state', () => ({
  useQueryState: (key: string, defaultValue: string = '') => {
    const [value, setValue] = React.useState<string>(queryState[key] ?? defaultValue)
    querySetters[key] = setValue
    const setter = (v: string) => {
      queryState[key] = v
      setValue(v)
    }
    return [value, setter, setter]
  },
  useQueryArrayState: (key: string) => {
    const [value, setValue] = React.useState<string[]>([])
    querySetters[key] = (v: string) => setValue(v ? v.split(',') : [])
    return [value, setValue]
  },
}))

// useSearch: controllable mock — tests can configure results before render.
type StubSearchResult = {
  id: string
  table: string
  score: number
  fields: Record<string, unknown>
}

let stubSearchResults: StubSearchResult[] = []
let debug = false
let deleteResponse: () => Promise<Response> = async () => new Response(null, { status: 204 })
const searchSpy = mock<(q: string) => void>()
const clearSpy = mock<() => void>()
const routerPushSpy = mock<(path: string) => void>()

mock.module('@/hooks/use-search', () => ({
  useSearch: () => ({
    results: stubSearchResults,
    aggregations: {},
    loading: false,
    error: null,
    meta: null,
    search: searchSpy,
    clear: clearSpy,
  }),
  reorderBySearchResults: <T extends { id: string }>(items: T[]) => items,
}))

// ---------------------------------------------------------------------------
// Stub UI shells so we don't pull in tailwind/cn or large component graphs.
// ---------------------------------------------------------------------------

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

mock.module('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

// ---------------------------------------------------------------------------
// Module under test (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { ProjectList } from '../components/project-list'

// ---------------------------------------------------------------------------
// Fixtures + fetch stub
// ---------------------------------------------------------------------------

const fixtureProjects = [
  {
    id: 'p1',
    title: 'Alpha Launch',
    status: 'active',
    progress: 50,
    taskCount: 3,
    brainstormStreaming: true,
    brainstormUnread: true,
    updated: '2026-04-10T00:00:00Z',
  },
  {
    id: 'p2',
    title: 'Beta Roadmap',
    status: 'active',
    progress: 25,
    taskCount: 2,
    brainstormUnread: true,
    updated: '2026-04-09T00:00:00Z',
  },
  {
    id: 'p3',
    title: 'Gamma Cleanup',
    status: 'draft',
    progress: 10,
    taskCount: 1,
    updated: '2026-04-08T00:00:00Z',
  },
]

const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : String(input)
  if (init?.method === 'DELETE') return deleteResponse()
  if (url === '/api/plugins/projects/' && init?.method === 'POST') {
    return {
      ok: true,
      json: async () => ({ ok: true, id: 'created-project' }),
      text: async () => '',
    }
  }
  return {
    ok: true,
    json: async () => ({ projects: fixtureProjects }),
    text: async () => '',
  }
}) as unknown as typeof fetch

beforeEach(() => {
  for (const k of Object.keys(queryState)) delete queryState[k]
  for (const k of Object.keys(querySetters)) delete querySetters[k]
  stubSearchResults = []
  debug = false
  deleteResponse = async () => new Response(null, { status: 204 })
  searchSpy.mockClear()
  clearSpy.mockClear()
  routerPushSpy.mockClear()
  ;(globalThis as unknown as { __bakinTestSdkHooks?: Record<string, unknown> }).__bakinTestSdkHooks = {
    useDebug: () => [debug, () => {}],
    useRouter: () => ({
      push: routerPushSpy,
      replace: mock(),
      back: mock(),
    }),
    useSearch: () => ({
      get results() {
        return stubSearchResults
      },
      aggregations: {},
      loading: false,
      error: null,
      meta: null,
      search: searchSpy,
      clear: clearSpy,
    }),
  }
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
  ;(fetchMock as unknown as { mockClear: () => void }).mockClear?.()
})

afterEach(() => {
  delete (globalThis as unknown as { __bakinTestSdkHooks?: unknown }).__bakinTestSdkHooks
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectList', () => {
  it('renders the search input from the shared page header', async () => {
    render(<ProjectList />)

    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: 'Search projects' })).toBeDefined()
    })
    expect(screen.getByRole('region', { name: 'Project filters' }).getAttribute('data-variant')).toBe('filters')
  })

  it('renders one separated list with solid states and a soft header count', async () => {
    render(<ProjectList />)
    const list = await screen.findByRole('list', { name: 'Projects' })
    expect(list.getAttribute('data-variant')).toBe('separated')
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    // The lightweight SDK test doubles forward these props as attributes.
    expect(screen.getByText('3 shown').getAttribute('variant')).toBe('soft')
    expect(within(list).getAllByText('Active')[0].getAttribute('variant')).toBe('solid')
    fireEvent.click(within(list).getByRole('button', { name: 'Open project: Alpha Launch' }))
    expect(routerPushSpy).toHaveBeenCalledWith('/projects/p1')
  })

  it('calls useSearch.search() when the URL search state updates', async () => {
    render(<ProjectList />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open project: Alpha Launch' })).toBeDefined()
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'alpha' } })

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith('alpha')
    })
  })

  it('filters and reorders the list to match useSearch results by score', async () => {
    stubSearchResults = [
      { id: 'p2', table: 'bakin_projects', score: 0.95, fields: {} },
      { id: 'p1', table: 'bakin_projects', score: 0.4, fields: {} },
    ]

    render(<ProjectList />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open project: Alpha Launch' })).toBeDefined()
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'launch' } })

    await waitFor(() => {
      // p3 is excluded entirely; p1 and p2 remain
      expect(screen.queryByRole('button', { name: 'Open project: Gamma Cleanup' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open project: Alpha Launch' })).not.toBeNull()
      expect(screen.queryByRole('button', { name: 'Open project: Beta Roadmap' })).not.toBeNull()
    })

    // p2 (higher score) should appear before p1 in the DOM order
    const rows = within(screen.getByRole('list', { name: 'Projects' })).getAllByRole('listitem')
    expect(within(rows[0]).getByText('Beta Roadmap')).toBeDefined()
    expect(within(rows[1]).getByText('Alpha Launch')).toBeDefined()
  })

  it('falls back to local substring filter on title when useSearch returns empty', async () => {
    stubSearchResults = []

    render(<ProjectList />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open project: Alpha Launch' })).toBeDefined()
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'beta' } })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Open project: Beta Roadmap' })).not.toBeNull()
      expect(screen.queryByRole('button', { name: 'Open project: Alpha Launch' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open project: Gamma Cleanup' })).toBeNull()
    })
  })

  it('creates a titled project before opening the edit view', async () => {
    render(<ProjectList />)

    await waitFor(() => {
      expect(screen.getByText('New Project')).toBeDefined()
    })

    fireEvent.click(screen.getByText('New Project'))
    const titleInput = screen.getByPlaceholderText('Project title...')
    const createButton = screen.getByText('Create Project') as HTMLButtonElement
    expect(createButton.disabled).toBe(true)

    fireEvent.change(titleInput, { target: { value: 'Website Refresh' } })
    expect((screen.getByText('Create Project') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Create Project'))

    await waitFor(() => {
      expect(routerPushSpy).toHaveBeenCalledWith('/projects/created-project/edit')
    })

    const fetchCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const createCall = fetchCalls.find(([url, init]) => (
      url === '/api/plugins/projects/'
      && (init as RequestInit | undefined)?.method === 'POST'
    ))
    expect(createCall).toBeDefined()
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({ title: 'Website Refresh' })
  })

  it('preserves progress, item counts, and live brainstorm attention in each row', async () => {
    render(<ProjectList />)
    const rows = within(await screen.findByRole('list', { name: 'Projects' })).getAllByRole('listitem')
    expect(within(rows[0]).getByRole('progressbar', { name: 'Alpha Launch progress' }).getAttribute('value')).toBe('50')
    expect(within(rows[0]).getByText('50% complete')).toBeDefined()
    expect(within(rows[0]).getByText('3 items')).toBeDefined()
    expect(within(rows[0]).getByText(/^Updated /)).toBeDefined()
    expect(within(rows[0]).getByRole('img', { name: 'Brainstorm reply in progress' })).toBeDefined()
    expect(within(rows[0]).queryByRole('img', { name: 'Unseen brainstorm reply' })).toBeNull()
    expect(within(rows[1]).getByRole('img', { name: 'Unseen brainstorm reply' })).toBeDefined()
    expect(within(rows[2]).queryByRole('img')).toBeNull()
  })

  it('shows row-shaped loading placeholders until the request finishes', () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    render(<ProjectList />)
    const list = screen.getByRole('list', { hidden: true })
    expect(list.getAttribute('aria-label')).toBe('Loading projects')
    expect(list.getAttribute('data-variant')).toBe('separated')
    expect(within(list).getAllByRole('listitem', { hidden: true })).toHaveLength(6)
    expect(within(list).queryByRole('button')).toBeNull()
  })

  it('clears an empty search and returns to the same list', async () => {
    render(<ProjectList />)
    await screen.findByRole('list', { name: 'Projects' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'no-match' } })
    expect(screen.getByText('No matching projects')).toBeDefined()
    expect(screen.queryByRole('list', { name: 'Projects' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(within(screen.getByRole('list', { name: 'Projects' })).getAllByRole('listitem')).toHaveLength(3)
  })

  it('keeps debug relevance overlays out of the row activation layer', async () => {
    debug = true
    stubSearchResults = [{ id: 'p1', table: 'bakin_projects', score: 0.9, fields: {} }]
    render(<ProjectList />)
    await screen.findByRole('list', { name: 'Projects' })
    expect(screen.queryByRole('note')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'alpha' } })
    const overlay = screen.getByRole('note', { name: 'Search relevance details' })
    expect(overlay.textContent).toContain('0.9000')
    // Direct ListRow children receive relative positioning and click-through.
    // Keep this absolute, tooltip-bearing note nested in the content instead.
    expect(overlay.parentElement?.getAttribute('data-slot')).not.toBe('list-row')
    expect(overlay.classList.contains('absolute')).toBe(true)
    expect(overlay.classList.contains('pointer-events-auto')).toBe(true)
  })

  async function requestDelete(title = 'Alpha Launch') {
    const trigger = await screen.findByRole('button', { name: `More actions for ${title}` })
    fireEvent.click(trigger)
    const row = trigger.closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Delete project' }))
    return screen.getByRole('dialog', { name: 'Delete project?' })
  }

  function deleteCalls() {
    return (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .filter(([, init]) => init?.method === 'DELETE')
  }

  it('opens a named delete confirmation without navigating, and cancel does not delete', async () => {
    render(<ProjectList />)
    const dialog = await requestDelete()
    expect(dialog.textContent).toContain('Alpha Launch')
    expect(dialog.textContent).toContain('Linked board tasks and assets will be kept')
    expect(routerPushSpy).not.toHaveBeenCalled()
    expect(deleteCalls()).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Open project: Alpha Launch' })).toBeDefined()
  })

  it('deletes only the confirmed project, keeps linked tasks, and updates the list count', async () => {
    render(<ProjectList />)
    const dialog = await requestDelete('Beta Roadmap')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const calls = deleteCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/api/plugins/projects/p2')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ deleteLinkedTasks: false })
    expect(screen.queryByRole('button', { name: 'Open project: Beta Roadmap' })).toBeNull()
    expect(screen.getByText('2 shown')).toBeDefined()
    expect(routerPushSpy).not.toHaveBeenCalled()
  })

  it('keeps the project on HTTP failure and permits an explicit retry', async () => {
    deleteResponse = async () => new Response('unavailable', { status: 503 })
    render(<ProjectList />)
    const dialog = await requestDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    await within(dialog).findByRole('alert')
    expect(screen.getByRole('button', { name: 'Open project: Alpha Launch' })).toBeDefined()
    expect(screen.getByText('3 shown')).toBeDefined()
    deleteResponse = async () => new Response(null, { status: 204 })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteCalls()).toHaveLength(2)
  })

  it('blocks duplicate confirmation and dismissal while deletion is pending', async () => {
    let finish!: (response: Response) => void
    deleteResponse = () => new Promise(resolve => { finish = resolve })
    render(<ProjectList />)
    const dialog = await requestDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    const deleting = within(dialog).getByRole('button', { name: 'Deleting…' }) as HTMLButtonElement
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(deleting.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    fireEvent.click(deleting)
    fireEvent.click(cancel)
    expect(deleteCalls()).toHaveLength(1)
    expect(screen.getByRole('dialog')).toBeDefined()
    finish(new Response(null, { status: 204 }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('does not restore a deleted row when an earlier background refresh settles late', async () => {
    render(<ProjectList />)
    await screen.findByRole('list', { name: 'Projects' })
    let finishRefresh!: (response: Response) => void
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return deleteResponse()
      return new Promise<Response>(resolve => { finishRefresh = resolve })
    }) as unknown as typeof fetch
    act(() => emitPluginEvent({ event: 'projects.brainstorm.done', projectId: 'p1' }))
    const dialog = await requestDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => finishRefresh(Response.json({ projects: fixtureProjects })))
    expect(screen.queryByRole('button', { name: 'Open project: Alpha Launch' })).toBeNull()
    expect(screen.getByText('2 shown')).toBeDefined()
  })

  it('keeps the confirmation and project visible when the network request rejects', async () => {
    deleteResponse = async () => { throw new Error('Network unavailable') }
    render(<ProjectList />)
    const dialog = await requestDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Network unavailable')
    expect(screen.getByText('3 shown')).toBeDefined()
    expect((within(dialog).getByRole('button', { name: 'Delete project' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the standard empty state after deleting the final project', async () => {
    render(<ProjectList />)
    for (const project of fixtureProjects) {
      const dialog = await requestDelete(project.title)
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
      })
      expect(screen.queryByRole('dialog')).toBeNull()
    }
    expect(screen.getByText('0 shown')).toBeDefined()
    expect(screen.getByText('No projects yet')).toBeDefined()
    expect(screen.queryByRole('list', { name: 'Projects' })).toBeNull()
  })
})
