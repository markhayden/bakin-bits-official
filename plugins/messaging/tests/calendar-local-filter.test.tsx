// @vitest-environment jsdom

/**
 * Calendar local filter smoke tests.
 *
 * The content calendar reads Deliverables directly and keeps filtering local:
 * title | brief | draft.caption | draft.agentNotes, plus URL-backed facets.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Deliverable } from '../../../plugins/messaging/types'
import { __resetContentTypesCache } from '../../../plugins/messaging/hooks/use-content-types'

const testDir = join(tmpdir(), `bakin-test-messaging-calfilter-${Date.now()}`)
const originalEventSource = globalThis.EventSource

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
  createLogger: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }),
}))

mock.module('@/core/watcher', () => ({
  registerSyncHook: mock(),
  registerUnlinkHook: mock(),
}))

mock.module('@makinbakin/sdk/components', () => ({
  AgentAvatar: ({ agentId }: { agentId: string }) => <span data-testid={`avatar-${agentId}`}>{agentId}</span>,
  AgentFilter: ({ agentIds }: { agentIds: string[] }) => (
    <div data-testid="agent-filter">
      {agentIds.map((agentId) => (
        <span key={agentId} data-testid={`agent-option-${agentId}`}>
          {agentId}
        </span>
      ))}
    </div>
  ),
  AgentSelect: () => <select />,
  BakinDrawer: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  ChannelIcon: ({ channelId }: { channelId: string }) => <span data-testid={`channel-icon-${channelId}`} />,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  FacetFilter: ({ label, options }: {
    label: string
    options: Array<{ value: string; label: string }>
  }) => (
    <div data-testid={`facet-${label}`}>
      {options.map((option) => (
        <span key={option.value} data-testid={`facet-option-${label}-${option.value}`}>
          {option.label}
        </span>
      ))}
    </div>
  ),
  PluginHeader: ({ title, count, actions }: Record<string, unknown>) => (
    <div data-testid="plugin-header">
      <h1>{title as string}</h1>
      <span data-testid="header-count">{String(count ?? '')}</span>
      <div>{actions as React.ReactNode}</div>
    </div>
  ),
}))

mock.module('@/hooks/use-query-state', () => {
  const { useState } = require('react') as typeof import('react')
  return {
    useQueryState: (_key: string, defaultValue?: string) => {
      const [value, setValue] = useState(defaultValue ?? '')
      return [value, setValue, setValue]
    },
    useQueryArrayState: () => {
      const [value, setValue] = useState<string[]>([])
      return [value, setValue, setValue]
    },
  }
})

mock.module('@/components/plugin-header', () => ({
  PluginHeader: ({ title, count, actions }: Record<string, unknown>) => (
    <div data-testid="plugin-header">
      <h1>{title as string}</h1>
      <span data-testid="header-count">{String(count ?? '')}</span>
      <div>{actions as React.ReactNode}</div>
    </div>
  ),
}))

mock.module('@/components/facet-filter', () => ({
  FacetFilter: () => null,
}))

mock.module('@/components/agent-filter', () => ({
  AgentFilter: () => null,
}))

mock.module('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

mock.module('@/components/agent-avatar', () => ({
  AgentAvatar: ({ agentId }: { agentId: string }) => <span data-testid={`avatar-${agentId}`} />,
}))

mock.module('@bakin/workflows/hooks/channel-icon', () => ({
  ChannelIcon: ({ channelId }: { channelId: string }) => <span data-testid={`channel-icon-${channelId}`} />,
}))

mock.module('@/components/ui/input', () => ({
  Input: ({ value, onChange, placeholder }: Record<string, unknown>) => (
    <input
      data-testid="calendar-search-input"
      value={value as string}
      onChange={onChange as (e: React.ChangeEvent<HTMLInputElement>) => void}
      placeholder={placeholder as string}
    />
  ),
}))

mock.module('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: Record<string, unknown>) => (
    <span data-testid="badge" {...props}>{children as React.ReactNode}</span>
  ),
}))

mock.module('@/components/ui/skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}))

class FakeEventSource {
  url: string
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  constructor(url: string) {
    this.url = url
  }
  close() {}
}
;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource

import { ContentCalendar } from '../../../plugins/messaging/components/content-calendar'

const DELIVERABLES: Deliverable[] = [
  {
    id: 'a',
    planId: 'plan-1',
    channel: 'general',
    contentType: 'blog',
    tone: 'energetic',
    agent: 'basil',
    title: 'Spring Smoothie',
    brief: 'Refreshing morning drink',
    publishAt: '2026-04-15T10:00:00Z',
    prepStartAt: '2026-04-12T10:00:00Z',
    status: 'planned',
    taskId: 'task-a',
    draft: { caption: 'Try this!', agentNotes: 'Use mango' },
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'b',
    planId: 'plan-2',
    channel: 'general',
    contentType: 'x-post',
    tone: 'energetic',
    agent: 'scout',
    title: 'Trail Run Tips',
    brief: 'Outdoor running advice',
    publishAt: '2026-04-16T10:00:00Z',
    prepStartAt: '2026-04-16T06:00:00Z',
    status: 'approved',
    taskId: 'task-b',
    draft: { caption: 'Hit the trails', agentNotes: 'mention shoes' },
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'c',
    planId: null,
    channel: 'announcements',
    contentType: 'newsletter',
    tone: 'calm',
    agent: 'zen',
    title: 'Mindful Breathing',
    brief: 'Box breathing intro',
    publishAt: '2026-04-17T10:00:00Z',
    prepStartAt: '2026-04-17T09:00:00Z',
    status: 'planned',
    draft: {},
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'invalid-plan-owned',
    planId: 'plan-bad',
    channel: 'instagram',
    contentType: 'image-social-post',
    tone: 'calm',
    agent: 'scout',
    title: 'Invalid plan duplicate',
    brief: 'This leaked before activation and should not show on the calendar.',
    publishAt: '2026-04-18T10:00:00Z',
    prepStartAt: '2026-04-17T09:00:00Z',
    status: 'planned',
    draft: {},
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'proposal',
    planId: null,
    channel: 'reddit',
    contentType: 'text-social-post',
    tone: 'calm',
    agent: 'scout',
    title: 'Proposal only',
    brief: 'Proposals are not scheduled calendar work.',
    publishAt: '2026-04-19T10:00:00Z',
    prepStartAt: '2026-04-18T09:00:00Z',
    status: 'proposed',
    draft: {},
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  },
]

function mockFetchDeliverables() {
  globalThis.fetch = mock().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/deliverables')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deliverables: DELIVERABLES }),
      })
    }
    if (typeof url === 'string' && url.startsWith('/api/plugin-settings/messaging')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ contentTypes: [
          { id: 'blog', label: 'Blog post' },
          { id: 'x-post', label: 'X post' },
        ] }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  __resetContentTypesCache()
  mockFetchDeliverables()
})

afterEach(() => {
  cleanup()
  __resetContentTypesCache()
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource
  } else {
    delete (globalThis as Partial<typeof globalThis>).EventSource
  }
})

describe('ContentCalendar (Deliverable local filter)', () => {
  it('renders without crashing', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeDefined()
    })
  })

  it('shows only calendar-visible Deliverables when search query is empty', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
    })
    expect(screen.getByTestId('calendar-deliverable-b')).toBeDefined()
    expect(screen.getByTestId('calendar-deliverable-c')).toBeDefined()
    expect(screen.queryByTestId('calendar-deliverable-invalid-plan-owned')).toBeNull()
    expect(screen.queryByTestId('calendar-deliverable-proposal')).toBeNull()
  })

  it('exposes the "Search calendar..." placeholder on the input', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search calendar...')).toBeDefined()
    })
  })

  it('includes orphan Deliverable references in filter options', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-c')).toBeDefined()
    })

    expect(screen.getByTestId('agent-option-zen')).toBeDefined()
    expect(screen.getByTestId('facet-option-Type-newsletter').textContent).toBe('newsletter')
    expect(screen.getByTestId('calendar-deliverable-c').textContent).toContain('newsletter')
  })

  it('filters by title substring case-insensitively', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
    })
    fireEvent.change(screen.getByPlaceholderText('Search calendar...'), { target: { value: 'SMOOTHIE' } })
    await waitFor(() => {
      expect(screen.queryByTestId('calendar-deliverable-b')).toBeNull()
    })
    expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
    expect(screen.queryByTestId('calendar-deliverable-c')).toBeNull()
  })

  it('filters by brief substring', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-b')).toBeDefined()
    })
    fireEvent.change(screen.getByPlaceholderText('Search calendar...'), { target: { value: 'breathing' } })
    await waitFor(() => {
      expect(screen.queryByTestId('calendar-deliverable-a')).toBeNull()
    })
    expect(screen.getByTestId('calendar-deliverable-c')).toBeDefined()
  })

  it('filters by draft.caption substring', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
    })
    fireEvent.change(screen.getByPlaceholderText('Search calendar...'), { target: { value: 'hit the trails' } })
    await waitFor(() => {
      expect(screen.queryByTestId('calendar-deliverable-a')).toBeNull()
    })
    expect(screen.getByTestId('calendar-deliverable-b')).toBeDefined()
  })

  it('filters by draft.agentNotes substring', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
    })
    fireEvent.change(screen.getByPlaceholderText('Search calendar...'), { target: { value: 'mango' } })
    await waitFor(() => {
      expect(screen.queryByTestId('calendar-deliverable-b')).toBeNull()
    })
    expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
  })

  it('renders zero Deliverables when the query matches nothing', async () => {
    render(<ContentCalendar />)
    await waitFor(() => {
      expect(screen.getByTestId('calendar-deliverable-a')).toBeDefined()
    })
    fireEvent.change(screen.getByPlaceholderText('Search calendar...'), { target: { value: 'nothing-matches-xyz' } })
    await waitFor(() => {
      expect(screen.queryByTestId('calendar-deliverable-a')).toBeNull()
    })
    expect(screen.getByText('No deliverables match filters')).toBeDefined()
  })

  it('does not import useSearch', () => {
    const source = readFileSync(
      join(__dirname, '../../../plugins/messaging/components/content-calendar.tsx'),
      'utf-8',
    )
    expect(source).not.toMatch(/@\/hooks\/use-search/)
    expect(source).not.toMatch(/from ['"][^'"]*hooks\/use-search['"]/)
  })
})
