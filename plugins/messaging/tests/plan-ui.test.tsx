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
  suggestedChannels: ['newsletter'],
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

let fanOutStarted = false
let deliverables: Deliverable[] = []
const putBodies: Record<string, unknown>[] = []

function installFetchMock() {
  globalThis.fetch = mock().mockImplementation(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/plans/plan-1/start-fanout')) {
      fanOutStarted = true
      return { ok: true, json: async () => ({ ok: true, plan: { ...PLAN, fanOutTaskId: 'task-1' }, taskId: 'task-1' }) }
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/plans/plan-1')) {
      return {
        ok: true,
        json: async () => ({
          plan: fanOutStarted ? { ...PLAN, fanOutTaskId: 'task-1' } : PLAN,
          deliverables,
        }),
      }
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/plans')) {
      return { ok: true, json: async () => ({ plans: [PLAN] }) }
    }
    if (typeof url === 'string' && url.startsWith('/api/plugins/messaging/deliverables/deliverable-1')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      putBodies.push(body)
      deliverables = deliverables.map((deliverable) =>
        deliverable.id === 'deliverable-1'
          ? { ...deliverable, status: body.status as Deliverable['status'] }
          : deliverable,
      )
      return { ok: true, json: async () => ({ ok: true, deliverable: deliverables[0] }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  fanOutStarted = false
  deliverables = [PROPOSED_DELIVERABLE]
  putBodies.length = 0
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
      expect(screen.getByText('Content Piece Suggestions')).toBeDefined()
    })
    expect(screen.queryByText('Start fan-out')).toBeNull()
    expect(fanOutStarted).toBe(false)
  })

  it('approves proposed Deliverables into planned status', async () => {
    render(<PlanWorkspace planId="plan-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText('Accept Soup blog')).toBeDefined()
    })
    fireEvent.click(screen.getByLabelText('Accept Soup blog'))

    await waitFor(() => {
      expect(putBodies[0]).toEqual({ status: 'planned' })
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
