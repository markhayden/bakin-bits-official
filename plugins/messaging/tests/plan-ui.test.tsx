// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      return { ok: true, json: async () => ({ plans: [planResponse] }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  activationStarted = false
  planResponse = PLAN
  deliverables = []
  installFetchMock()
})

afterEach(() => cleanup())

describe('Plan client UI', () => {
  it('renders Plans and calls onSelectPlan when a Plan is selected', async () => {
    const onSelectPlan = mock()
    render(<PlanList onSelectPlan={onSelectPlan} />)

    await waitFor(() => {
      expect(screen.getByText('Soup Week')).toBeDefined()
    })
    fireEvent.click(screen.getByText('Soup Week'))

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

  it('deletes a Plan and returns to the Plan list', async () => {
    const onDeleted = mock()
    render(<PlanWorkspace planId="plan-1" onDeleted={onDeleted} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Delete plan')).toBeDefined()
    })
    fireEvent.click(screen.getByLabelText('Delete plan'))
    fireEvent.click(screen.getByText('Delete plan'))

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalled()
    })
  })
})
