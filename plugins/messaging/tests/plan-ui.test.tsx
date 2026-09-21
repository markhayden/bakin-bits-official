// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Deliverable, Plan } from '../../../plugins/messaging/types'

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
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
    <div>
      <h1>{title as string}</h1>
      <span data-testid="header-count">{String(count ?? '')}</span>
      <div>{actions as React.ReactNode}</div>
    </div>
  ),
}))

mock.module('@/components/agent-filter', () => ({
  AgentFilter: () => null,
}))

mock.module('@/components/facet-filter', () => ({
  FacetFilter: () => null,
}))

mock.module('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

mock.module('@/components/agent-avatar', () => ({
  AgentAvatar: ({ agentId }: { agentId: string }) => <span data-testid={`avatar-${agentId}`} />,
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, title, ...props }: Record<string, unknown>) => (
    <button onClick={onClick as () => void} disabled={disabled as boolean} title={title as string} {...props}>
      {children as React.ReactNode}
    </button>
  ),
}))

mock.module('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: Record<string, unknown>) => (
    <span data-testid="badge" {...props}>{children as React.ReactNode}</span>
  ),
}))

mock.module('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}))

mock.module('@/components/ui/skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}))

class FakeEventSource {
  url: string
  onmessage: ((ev: MessageEvent) => void) | null = null
  constructor(url: string) {
    this.url = url
  }
  close() {}
}
;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource

import { PlanList } from '../../../plugins/messaging/components/plan-list'
import { PlanWorkspace } from '../../../plugins/messaging/components/plan-workspace'

const PLAN: Plan = {
  id: 'plan-1',
  title: 'Soup Week',
  brief: 'A plan about soup content.',
  targetDate: '2026-05-25',
  agent: 'basil',
  status: 'planning',
  channels: [{
    id: 'newsletter',
    channel: 'newsletter',
    contentType: 'blog',
    publishAt: '2026-05-25T16:00:00Z',
    prepStartAt: '2026-05-22T16:00:00Z',
  }],
  createdAt: '2026-05-10T00:00:00Z',
  updatedAt: '2026-05-10T00:00:00Z',
}

const PROPOSED_DELIVERABLE: Deliverable = {
  id: 'deliverable-1',
  planId: 'plan-1',
  channel: 'newsletter',
  contentType: 'blog',
  tone: 'conversational',
  agent: 'basil',
  title: 'Soup blog',
  brief: 'Write the soup blog.',
  publishAt: '2026-05-25T16:00:00Z',
  prepStartAt: '2026-05-22T16:00:00Z',
  status: 'proposed',
  draft: {},
  createdAt: '2026-05-10T00:00:00Z',
  updatedAt: '2026-05-10T00:00:00Z',
}

let activationStarted = false
let planResponse: Plan = PLAN
let deliverables: Deliverable[] = []
let listPlans: Plan[] | undefined
let listFails = false

function installFetchMock() {
  globalThis.fetch = mock().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/plugin-settings/messaging')) {
      return { ok: true, json: async () => ({ contentTypes: [{ id: 'blog', label: 'Blog post', prepLeadHours: 72 }] }) }
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/plans/plan-1/activate')) {
      activationStarted = true
      planResponse = { ...planResponse, status: 'in_prep' }
      deliverables = [{
        ...PROPOSED_DELIVERABLE,
        id: 'deliverable-activated',
        status: 'planned',
        taskId: 'task-1',
      }]
      return { ok: true, json: async () => ({ ok: true, plan: planResponse, deliverables, taskIds: ['task-1'], alreadyActivated: false }) }
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/plans/plan-1')) {
      return {
        ok: true,
        json: async () => ({
          plan: planResponse,
          deliverables,
        }),
      }
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/plans')) {
      return { ok: !listFails, status: listFails ? 503 : 200, json: async () => ({ plans: listPlans ?? [planResponse] }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  activationStarted = false
  planResponse = PLAN
  deliverables = []
  listPlans = undefined
  listFails = false
  installFetchMock()
})

afterEach(() => cleanup())

describe('Plan client UI', () => {
  it('uses separated date groups and a soft shown count without changing review priority', async () => {
    listPlans = [
      { ...PLAN, id: 'later', title: 'Later plan', targetDate: '2026-05-26' },
      { ...PLAN, id: 'recent', title: 'Recently updated', updatedAt: '2026-05-12T00:00:00Z' },
      { ...PLAN, id: 'review', title: 'Review first', status: 'needs_review' },
      { ...PLAN, id: 'older', title: 'Older plan' },
    ]
    render(<PlanList />)
    await screen.findByText('Review first')
    const headers = screen.getAllByRole('heading', { level: 2 })
    expect(headers.map(header => header.textContent)).toEqual(['May 25, 20263 plans', 'May 26, 20261 plan'])
    expect(headers.every(header => header.getAttribute('data-header-tone') === 'accent')).toBe(true)
    const lists = screen.getAllByRole('list')
    expect(lists).toHaveLength(2)
    expect(lists.every(list => list.getAttribute('data-variant') === 'separated')).toBe(true)
    expect(within(lists[0]).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Open plan: Review first', 'Open plan: Recently updated', 'Open plan: Older plan',
    ])
    expect(within(lists[1]).getByRole('button', { name: 'Open plan: Later plan' })).toBeDefined()
    expect(screen.getByText('4 shown').getAttribute('variant')).toBe('soft')
  })

  it('searches campaign text and removes empty date groups, then clears the search', async () => {
    listPlans = [PLAN, { ...PLAN, id: 'later', title: 'Later plan', targetDate: '2026-05-26', campaign: 'Summer launch' }]
    render(<PlanList />)
    await screen.findByText('Soup Week')
    const search = screen.getByRole('searchbox', { name: 'Search plans' })
    fireEvent.change(search, { target: { value: 'Summer launch' } })
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.queryByText('Soup Week')).toBeNull()
    fireEvent.change(search, { target: { value: 'no-match' } })
    expect(screen.getByText('No plans match this view')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getAllByRole('list')).toHaveLength(2)
  })

  it('distinguishes load failure from an empty list and allows retry', async () => {
    listFails = true
    render(<PlanList />)
    await screen.findByText('Could not load plans')
    expect(screen.queryByText('No plans yet')).toBeNull()
    listFails = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Soup Week')
    expect(screen.queryByText('Could not load plans')).toBeNull()
  })

  it('hides the shown count during loading and preserves the initial-empty action', async () => {
    listPlans = []
    const onStartBrainstorm = mock()
    render(<PlanList onStartBrainstorm={onStartBrainstorm} />)
    expect(screen.getByText('Loading plans')).toBeDefined()
    expect(screen.queryByText('0 shown')).toBeNull()
    await screen.findByText('No plans yet')
    expect(screen.getByText('0 shown')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Start brainstorming' }))
    expect(onStartBrainstorm).toHaveBeenCalledTimes(1)
  })

  it('renders Plans and calls onSelectPlan when a Plan is selected', async () => {
    const onSelectPlan = mock()
    render(<PlanList onSelectPlan={onSelectPlan} />)

    await waitFor(() => {
      expect(screen.getByText('Soup Week')).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open plan: Soup Week' }))

    expect(onSelectPlan).toHaveBeenCalledWith(PLAN)
  })

  it('renders the planning hub without starting background work', async () => {
    render(<PlanWorkspace planId="plan-1" />)

    await waitFor(() => {
      expect(screen.getByText('Tasks')).toBeDefined()
      expect(screen.getByText('Content Pieces')).toBeDefined()
    })
    expect(screen.queryByText('Start fan-out')).toBeNull()
    expect(activationStarted).toBe(false)
  })

  it('shows only selected channel rows after task-backed activation locks channels', async () => {
    planResponse = {
      ...PLAN,
      channels: [{
        id: 'instagram',
        channel: 'instagram',
        contentType: 'blog',
        publishAt: '2026-05-25T16:00:00Z',
        prepStartAt: '2026-05-22T16:00:00Z',
      }],
    }
    deliverables = [{
      ...PROPOSED_DELIVERABLE,
      channel: 'instagram',
      status: 'planned',
      taskId: 'task-1',
    }]

    render(<PlanWorkspace planId="plan-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText('Delete instagram channel')).toBeDefined()
    })
    expect(screen.queryByText('Select one or more channels')).toBeNull()
    expect(screen.queryByText('Channel edits are locked after activation because linked board tasks already exist.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Instagram' })).toBeNull()
  })

  it('requires an explicit kickoff before content prep starts', async () => {
    planResponse = { ...PLAN, status: 'needs_review' }
    deliverables = []
    render(<PlanWorkspace planId="plan-1" />)

    await waitFor(() => {
      expect(screen.getByText('Review this plan before work starts')).toBeDefined()
    })
    expect(activationStarted).toBe(false)

    fireEvent.click(screen.getByText('Kickoff content prep'))

    await waitFor(() => {
      expect(activationStarted).toBe(true)
    })
  })

  it('exposes a resizable details sidebar divider', async () => {
    render(<PlanWorkspace planId="plan-1" />)

    const handle = await screen.findByLabelText('Resize details panel')
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-valuenow')).toBe('346')
  })

  it('deletes a Plan and returns to the Plan list', async () => {
    const onDeleted = mock()
    render(<PlanWorkspace planId="plan-1" onDeleted={onDeleted} />)

    // Delete lives in the header overflow menu ("Plan actions" -> Delete),
    // then confirms through the typed ConfirmDialog.
    await waitFor(() => {
      expect(screen.getByLabelText('Plan actions')).toBeDefined()
    })
    fireEvent.click(screen.getByLabelText('Plan actions'))
    fireEvent.click(await screen.findByText('Delete'))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete plan' }))

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalled()
    })
  })
})
