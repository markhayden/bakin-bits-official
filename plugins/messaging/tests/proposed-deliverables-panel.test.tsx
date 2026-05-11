// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, title, disabled, ...props }: Record<string, unknown>) => (
    <button onClick={onClick as () => void} title={title as string} disabled={disabled as boolean} {...props}>
      {children as React.ReactNode}
    </button>
  ),
}))

mock.module('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: Record<string, unknown>) => (
    <span data-testid="badge" {...props}>{children as React.ReactNode}</span>
  ),
}))

import { ProposedDeliverablesPanel } from '../../../plugins/messaging/components/proposed-deliverables-panel'
import type { Deliverable } from '../../../plugins/messaging/types'

afterEach(() => cleanup())

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'd1',
    planId: 'plan-1',
    channel: 'newsletter',
    contentType: 'blog',
    tone: 'conversational',
    agent: 'basil',
    title: 'Soup blog',
    brief: 'Write the soup blog for the newsletter.',
    publishAt: '2026-05-25T16:00:00Z',
    prepStartAt: '2026-05-22T16:00:00Z',
    status: 'proposed',
    draft: {},
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    ...overrides,
  }
}

describe('ProposedDeliverablesPanel', () => {
  it('renders the empty state when there are no proposed Deliverables', () => {
    render(<ProposedDeliverablesPanel deliverables={[]} />)
    expect(screen.getByText('Proposed Deliverables')).toBeDefined()
    expect(screen.getByText('0 proposed')).toBeDefined()
    expect(screen.getByText('No proposed deliverables')).toBeDefined()
  })

  it('filters to proposed Deliverables and renders their details', () => {
    render(
      <ProposedDeliverablesPanel
        deliverables={[
          makeDeliverable({ id: 'd1', title: 'Soup blog' }),
          makeDeliverable({ id: 'd2', title: 'Approved soup', status: 'approved' }),
        ]}
      />,
    )

    expect(screen.getByText('1 proposed')).toBeDefined()
    expect(screen.getByText('Soup blog')).toBeDefined()
    expect(screen.queryByText('Approved soup')).toBeNull()
    expect(screen.getByText('newsletter')).toBeDefined()
    expect(screen.getByText('blog')).toBeDefined()
    expect(screen.getByText('conversational')).toBeDefined()
    expect(screen.getByText(/May 25/)).toBeDefined()
    expect(screen.getByText(/Write the soup blog/)).toBeDefined()
  })

  it('fires approve, reject, and edit callbacks with the Deliverable', () => {
    const deliverable = makeDeliverable({ title: 'Soup blog' })
    const onApprove = mock()
    const onReject = mock()
    const onEdit = mock()

    render(
      <ProposedDeliverablesPanel
        deliverables={[deliverable]}
        onApprove={onApprove}
        onReject={onReject}
        onEdit={onEdit}
      />,
    )

    fireEvent.click(screen.getByLabelText('Approve Soup blog'))
    fireEvent.click(screen.getByLabelText('Reject Soup blog'))
    fireEvent.click(screen.getByLabelText('Edit Soup blog'))

    expect(onApprove).toHaveBeenCalledWith(deliverable)
    expect(onReject).toHaveBeenCalledWith(deliverable)
    expect(onEdit).toHaveBeenCalledWith(deliverable)
  })
})
