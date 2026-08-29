// @vitest-environment jsdom

/**
 * Brainstorm search consumer smoke tests.
 *
 * Covers the C13 wiring: BrainstormView consumes `useSearch({ plugin:
 * 'messaging' })`, filters locally-fetched sessions by search hits
 * (stripping the `brainstorm-` key prefix), and falls back to a local
 * title/agentId substring filter when the hook returns nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = join(tmpdir(), `bakin-test-messaging-consumer-${Date.now()}`)
const originalMatchMedia = typeof window === 'undefined' ? undefined : window.matchMedia

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

// ---------------------------------------------------------------------------
// useSearch — capture per-call so tests can drive `results` from outside.
// ---------------------------------------------------------------------------

type Hook = {
  results: Array<{ id: string; table: string; score: number; fields: Record<string, unknown> }>
  search: ReturnType<typeof mock>
  clear: ReturnType<typeof mock>
  aggregations: Record<string, unknown>
  loading: boolean
  error: null
  meta: null
}

const hookState: Hook = {
  results: [],
  search: mock(),
  clear: mock(),
  aggregations: {},
  loading: false,
  error: null,
  meta: null,
}

const useSearchMock = mock((..._args: unknown[]) => hookState)

mock.module('@/hooks/use-search', () => ({
  useSearch: (...args: unknown[]) => useSearchMock(...args),
}))

// useQueryState — back with a plain useState so the search field is reactive.
mock.module('@/hooks/use-query-state', () => {
  const { useState } = require('react') as typeof import('react')
  return {
    useQueryState: (_key: string, defaultValue: string) => {
      const [value, setValue] = useState(defaultValue ?? '')
      return [value, setValue, setValue]
    },
    useQueryArrayState: () => {
      const [value, setValue] = useState<string[]>([])
      return [value, setValue, setValue]
    },
  }
})

// Heavy / unrelated children
mock.module('@/components/plugin-header', () => ({
  PluginHeader: ({ title, search }: { title: string; search?: { value: string; onChange: (v: string) => void; placeholder?: string } }) => (
    <div>
      <h1>{title}</h1>
      {search && (
        <input
          data-testid="brainstorm-search-input"
          value={search.value}
          placeholder={search.placeholder}
          onChange={(e) => search.onChange(e.target.value)}
        />
      )}
    </div>
  ),
}))

mock.module('@/components/agent-avatar', () => ({
  AgentAvatar: ({ agentId }: { agentId: string }) => <span data-testid={`avatar-${agentId}`} />,
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: Record<string, unknown>) => (
    <button onClick={onClick as () => void} disabled={disabled as boolean}>
      {children as React.ReactNode}
    </button>
  ),
}))

mock.module('@/components/ui/badge', () => ({
  Badge: ({ children }: Record<string, unknown>) => <span>{children as React.ReactNode}</span>,
}))

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: Record<string, unknown>) => <div>{children as React.ReactNode}</div>,
  DropdownMenuTrigger: ({ children }: Record<string, unknown>) => <div>{children as React.ReactNode}</div>,
  DropdownMenuContent: ({ children }: Record<string, unknown>) => <div>{children as React.ReactNode}</div>,
  DropdownMenuItem: ({ children, onClick }: Record<string, unknown>) => (
    <div onClick={onClick as () => void}>{children as React.ReactNode}</div>
  ),
}))

// Stub table components used by BrainstormView.
mock.module('@/components/ui/table', () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children, onClick, ...props }: { children: React.ReactNode; onClick?: () => void } & Record<string, unknown>) => (
    <tr onClick={onClick} {...props}>{children}</tr>
  ),
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
}))

// ---------------------------------------------------------------------------
// Imports — real BrainstormView
// ---------------------------------------------------------------------------
import { BrainstormView } from '../../../plugins/messaging/components/brainstorm-view'

const SESSIONS = [
  {
    id: 'sess-recipes',
    agentId: 'basil',
    title: 'Week 16 recipes',
    status: 'active' as const,
    createdAt: '2026-04-07T10:00:00Z',
    updatedAt: '2026-04-09T15:00:00Z',
    proposalCount: 5,
    approvedCount: 2,
  },
  {
    id: 'sess-outdoor',
    agentId: 'scout',
    title: 'Outdoor sprint',
    status: 'active' as const,
    createdAt: '2026-04-08T10:00:00Z',
    updatedAt: '2026-04-09T16:00:00Z',
    proposalCount: 3,
    approvedCount: 0,
  },
]

const ACTIVE_SESSION = {
  id: 'sess-recipes',
  agentId: 'basil',
  title: 'Week 16 recipes',
  status: 'active' as const,
  createdAt: '2026-04-07T10:00:00Z',
  updatedAt: '2026-04-09T15:00:00Z',
  messages: [
    {
      id: 'msg-1',
      role: 'assistant' as const,
      content: 'Launch week ideas are ready.',
      timestamp: '2026-04-09T15:00:00Z',
    },
  ],
  proposals: [
    {
      id: 'proposal-1',
      title: 'Launch Week',
      targetDate: '2026-05-25',
      brief: 'Announce the launch and show the adaptable workflow.',
      suggestedChannels: ['linkedin'],
      status: 'proposed' as const,
      createdAt: '2026-04-09T15:00:00Z',
      updatedAt: '2026-04-09T15:00:00Z',
    },
  ],
  planIds: [],
}

const ACCEPTED_SESSION = {
  ...ACTIVE_SESSION,
  id: 'sess-accepted',
  title: 'Accepted directions',
  proposals: [
    {
      ...ACTIVE_SESSION.proposals[0],
      id: 'proposal-accepted',
      status: 'approved' as const,
    },
  ],
}

const LINKED_SESSION = {
  ...ACCEPTED_SESSION,
  id: 'sess-linked',
  title: 'Plans already prepared',
  proposals: [
    {
      ...ACCEPTED_SESSION.proposals[0],
      id: 'proposal-linked',
      planId: 'plan-linked',
    },
  ],
  planIds: ['plan-linked'],
}

let searchParams = new URLSearchParams()

function mockFetchSessions() {
  globalThis.fetch = mock().mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url === '/api/plugins/messaging/sessions' && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          session: {
            id: 'sess-new',
            agentId: 'scout',
            title: 'May survival ideas',
            status: 'active',
            messages: [],
            proposals: [],
          },
        }),
      })
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/sessions/sess-recipes')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session: ACTIVE_SESSION }),
      })
    }
    if (typeof url === 'string' && url.includes('/sessions/sess-accepted/proposals/proposal-accepted') && init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          proposal: { ...ACCEPTED_SESSION.proposals[0], ...patch },
        }),
      })
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/sessions/sess-accepted')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session: ACCEPTED_SESSION }),
      })
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/sessions/sess-linked')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session: LINKED_SESSION }),
      })
    }
    if (typeof url === 'string' && url === '/api/plugins/messaging/sessions') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessions: SESSIONS }),
      })
    }
    return Promise.resolve({ ok: false })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  searchParams = new URLSearchParams()
  window.localStorage.clear()
  hookState.results = []
  hookState.search.mockClear()
  hookState.clear.mockClear()
  useSearchMock.mockClear()
  ;(globalThis as unknown as { __bakinTestSdkHooks?: Record<string, unknown> }).__bakinTestSdkHooks = {
    useSearch: (...args: unknown[]) => useSearchMock(...args),
    useAgentIds: () => ['basil', 'scout'],
    useAgentList: () => [
      { id: 'basil', name: 'Basil' },
      { id: 'scout', name: 'Scout' },
    ],
    useSearchParams: () => searchParams,
    usePathname: () => '/messaging/brainstorm',
    useRouter: () => ({
      push: mock(),
      replace: mock(),
      back: mock(),
    }),
  }
  mockFetchSessions()
})

afterEach(() => {
  delete (globalThis as unknown as { __bakinTestSdkHooks?: unknown }).__bakinTestSdkHooks
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: originalMatchMedia,
  })
  cleanup()
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BrainstormView (search consumer)', () => {
  it('renders without crashing and shows fetched sessions', async () => {
    render(<BrainstormView />)
    await waitFor(() => {
      expect(screen.getByText('Brainstorm')).toBeDefined()
    })
    await waitFor(() => {
      expect(screen.getByText('Week 16 recipes')).toBeDefined()
    })
    expect(screen.getByText('Outdoor sprint')).toBeDefined()
  })

  it('configures useSearch with plugin "messaging" and brainstorm facets', async () => {
    render(<BrainstormView />)
    await waitFor(() => {
      expect(screen.getByText('Week 16 recipes')).toBeDefined()
    })
    expect(useSearchMock).toHaveBeenCalled()
    const args = useSearchMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(args?.plugin).toBe('messaging')
    expect(args?.facets).toEqual(['status', 'agent_id'])
  })

  it('forwards typed query into searchHook.search()', async () => {
    render(<BrainstormView />)
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: 'Search brainstorm sessions' })).toBeDefined()
    })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search brainstorm sessions' }), {
      target: { value: 'recipes' },
    })
    await waitFor(() => {
      expect(hookState.search).toHaveBeenCalledWith('recipes')
    })
  })

  it('filters session list to search hits when results are non-empty (strips brainstorm- prefix)', async () => {
    hookState.results = [
      { id: 'brainstorm-sess-recipes', table: 'bakin_messaging_brainstorm', score: 0.95, fields: {} },
    ]
    render(<BrainstormView />)
    await waitFor(() => {
      expect(screen.getByText('Week 16 recipes')).toBeDefined()
    })

    // Trigger a query so the substring/empty branch is bypassed
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search brainstorm sessions' }), {
      target: { value: 'recipes' },
    })

    await waitFor(() => {
      // The matched session is still visible; the unmatched one is filtered out
      expect(screen.queryByText('Outdoor sprint')).toBeNull()
    })
    expect(screen.getByText('Week 16 recipes')).toBeDefined()
  })

  it('falls back to local title/agentId substring when searchHook.results is empty', async () => {
    hookState.results = [] // Search returned nothing
    render(<BrainstormView />)
    await waitFor(() => {
      expect(screen.getByText('Outdoor sprint')).toBeDefined()
    })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search brainstorm sessions' }), {
      target: { value: 'outdoor' },
    })
    await waitFor(() => {
      expect(screen.queryByText('Week 16 recipes')).toBeNull()
    })
    expect(screen.getByText('Outdoor sprint')).toBeDefined()
  })

  it('creates new brainstorm sessions from a modal with avatar agent selection', async () => {
    render(<BrainstormView />)
    await waitFor(() => {
      expect(screen.getByText('Week 16 recipes')).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'New brainstorm' }))

    expect(screen.getByRole('heading', { name: 'New brainstorm' })).toBeDefined()
    const agentGroup = screen.getByRole('radiogroup', { name: 'Brainstorm agent' })
    expect(within(agentGroup).getByTestId('avatar-scout')).toBeDefined()
    fireEvent.click(within(agentGroup).getByRole('radio', { name: /Scout/ }))
    fireEvent.change(screen.getByPlaceholderText('Session title...'), {
      target: { value: 'May survival ideas' },
    })
    fireEvent.click(screen.getByText('Create Session'))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/plugins/messaging/sessions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ agentId: 'scout', title: 'May survival ideas' }),
        }),
      )
    })
  })

  it('defaults active brainstorm sessions to resizable side-by-side columns', async () => {
    searchParams = new URLSearchParams('session=sess-recipes')

    render(<BrainstormView />)

    await waitFor(() => {
      expect(screen.getByText('Week 16 recipes')).toBeDefined()
    })

    expect(screen.getByRole('tab', { name: 'Columns' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('brainstorm-workspace-columns')).toBeDefined()
    expect(screen.getByTestId('conversation-panel')).toBeDefined()
    expect(screen.getByRole('separator', { name: 'Resize proposal panel' })).toBeDefined()
  })

  it('switches active brainstorm sessions to full-width tabbed panes', async () => {
    searchParams = new URLSearchParams('session=sess-recipes')

    render(<BrainstormView />)

    await waitFor(() => {
      expect(screen.getByText('Launch Week')).toBeDefined()
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Tabs' }))

    expect(screen.getByRole('tab', { name: 'Tabs' }).getAttribute('aria-selected')).toBe('true')
    expect(window.localStorage.getItem('messaging-brainstorm-layout')).toBe('tabs')
    expect(screen.getByRole('tablist', { name: 'Brainstorm layout sections' })).toBeDefined()
    expect(screen.getByRole('tabpanel', { name: 'Brainstorm' })).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: 'Plan proposals (1)' }))

    expect(screen.getByRole('tabpanel', { name: 'Plan proposals (1)' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Plan proposals' })).toBeNull()
    expect(screen.getByText('Launch Week')).toBeDefined()
  })

  it('forces the tabbed proposal review pattern on compact screens without overwriting the desktop preference', async () => {
    searchParams = new URLSearchParams('session=sess-recipes')
    window.localStorage.setItem('messaging-brainstorm-layout', 'columns')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        media: '(max-width: 767px)',
        onchange: null,
        addEventListener: mock(),
        removeEventListener: mock(),
        addListener: mock(),
        removeListener: mock(),
        dispatchEvent: mock(() => true),
      }),
    })

    render(<BrainstormView />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Week 16 recipes' })).toBeDefined()
    })

    expect(document.querySelector('[data-slot="brainstorm-tabbed-workspace"]')).toBeDefined()
    expect(screen.getByRole('tablist', { name: 'Brainstorm layout sections' })).toBeDefined()
    expect(screen.queryByTestId('brainstorm-workspace-columns')).toBeNull()
    expect(window.localStorage.getItem('messaging-brainstorm-layout')).toBe('columns')
    expect(screen.getByTestId('conversation-panel').parentElement?.className).toContain('overflow-hidden')
    const pageHeader = screen.getByRole('banner')
    expect(pageHeader.className).not.toContain('[&_[data-slot=page-header-trailing]]:absolute')
    expect(screen.getByRole('button', { name: 'Brainstorm actions' })).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: 'Plan proposals (1)' }))
    const proposalPanel = screen.getByTestId('brainstorm-proposal-panel')
    expect(proposalPanel?.className).toContain('max-w-full')
  })

  it('lets an accepted direction return to review before it has produced a plan', async () => {
    searchParams = new URLSearchParams('session=sess-accepted')

    render(<BrainstormView />)

    await waitFor(() => {
      expect(screen.getByText('Launch Week')).toBeDefined()
    })
    // The proposal is a kit Card whose whole-surface overlay carries the name.
    fireEvent.click(screen.getByRole('button', { name: 'Open proposal: Launch Week' }))

    const cancelAcceptance = await screen.findByRole('button', { name: 'Cancel acceptance' })
    fireEvent.click(cancelAcceptance)

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sessions/sess-accepted/proposals/proposal-accepted'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"status":"proposed"'),
        }),
      )
    })
  })

  it('allows an active session with already prepared plans to complete', async () => {
    searchParams = new URLSearchParams('session=sess-linked')

    render(<BrainstormView />)

    const complete = await screen.findByRole('button', { name: 'Complete session' })
    expect(complete.hasAttribute('disabled')).toBe(false)
  })
})
