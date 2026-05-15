// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Deliverable } from '../../../plugins/messaging/types'

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
}))

mock.module('@/components/bakin-drawer', () => ({
  BakinDrawer: ({ children, open, title }: { children: React.ReactNode; open: boolean; title?: string }) =>
    open ? <div data-testid="drawer"><h1>{title}</h1>{children}</div> : null,
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

mock.module('@/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}))

mock.module('@/components/ui/separator', () => ({
  Separator: () => <hr />,
}))

mock.module('../../../plugins/messaging/hooks/use-content-types', () => ({
  useContentTypes: () => [
    { id: 'image', label: 'Image post', assetRequirement: 'image' },
    { id: 'blog', label: 'Blog post', assetRequirement: 'optional-image' },
  ],
  getContentTypeLabel: (id: string, types: Array<{ id: string; label: string }>) =>
    types.find((type) => type.id === id)?.label ?? id,
}))

import { DeliverableDrawer } from '../../../plugins/messaging/components/deliverable-drawer'
import { DeliverableStatusBadge } from '../../../plugins/messaging/components/deliverable-status-badge'

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'deliverable-1',
    planId: 'plan-1',
    channel: 'general',
    contentType: 'image',
    tone: 'conversational',
    agent: 'basil',
    title: 'Image post',
    brief: 'Prepare an image post.',
    publishAt: '2026-05-25T16:00:00Z',
    prepStartAt: '2026-05-24T16:00:00Z',
    status: 'in_review',
    draft: {},
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  globalThis.fetch = mock(async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch
  globalThis.confirm = mock(() => true) as unknown as typeof confirm
})

afterEach(() => cleanup())

describe('DeliverableStatusBadge', () => {
  it('renders readable Deliverable status labels', () => {
    render(<DeliverableStatusBadge status="changes_requested" />)
    expect(screen.getByText('changes requested')).toBeDefined()
  })
})

describe('DeliverableDrawer', () => {
  it('disables approval when a required asset is missing', () => {
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable()}
        open
        onClose={mock()}
      />,
    )

    expect(screen.getByText('Required image asset missing')).toBeDefined()
    expect(screen.getByText('Approve').closest('button')?.disabled).toBe(true)
  })

  it('renders asset previews and failure reasons', () => {
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable({
          status: 'failed',
          draft: { imageFilename: 'hero image.png', caption: 'Caption' },
          failureReason: 'Asset hero image.png (image) not resolvable: missing',
        })}
        open
        onClose={mock()}
      />,
    )

    const img = screen.getByAltText('hero image.png') as HTMLImageElement
    expect(img.src).toContain('/api/assets/hero%20image.png')
    expect(screen.getByText('Failure reason')).toBeDefined()
    expect(screen.getByText(/not resolvable/)).toBeDefined()
  })

  it('calls the approve route for approvable Deliverables', async () => {
    const onUpdated = mock()
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable({ draft: { imageFilename: 'hero.png' } })}
        open
        onClose={mock()}
        onUpdated={onUpdated}
      />,
    )

    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/plugins/messaging/deliverables/deliverable-1/approve?id=deliverable-1',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(onUpdated).toHaveBeenCalled()
  })

  it('restores approval from a workflow handoff failure', async () => {
    const onClose = mock()
    const onUpdated = mock()
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable({
          status: 'failed',
          contentType: 'blog',
          failureReason: 'workflow.complete fired but messaging-side status was in_review',
          failureStage: 'workflow_handoff',
        })}
        open
        onClose={onClose}
        onUpdated={onUpdated}
      />,
    )

    fireEvent.click(screen.getByText('Restore approval'))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/plugins/messaging/deliverables/deliverable-1/restore-approval?id=deliverable-1',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(onUpdated).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('reopens prep from validation failures', async () => {
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable({
          status: 'failed',
          contentType: 'blog',
          failureReason: 'Required image asset missing on Deliverable',
          failureStage: 'validation',
        })}
        open
        onClose={mock()}
      />,
    )

    fireEvent.click(screen.getByText('Reopen prep'))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/plugins/messaging/deliverables/deliverable-1/reopen-prep?id=deliverable-1',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('confirms before retrying external delivery', async () => {
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable({
          status: 'failed',
          contentType: 'blog',
          failureReason: 'Channel delivery failed: offline',
          failureStage: 'delivery',
        })}
        open
        onClose={mock()}
      />,
    )

    fireEvent.click(screen.getByText('Retry delivery'))

    expect(globalThis.confirm).toHaveBeenCalledWith('Retry delivery to general? This may publish or send the content externally.')
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/plugins/messaging/deliverables/deliverable-1/retry-delivery?id=deliverable-1',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('deletes a scheduled content piece from the drawer', async () => {
    const onClose = mock()
    const onUpdated = mock()
    render(
      <DeliverableDrawer
        deliverable={makeDeliverable({ status: 'scheduled', contentType: 'blog' })}
        open
        onClose={onClose}
        onUpdated={onUpdated}
      />,
    )

    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm delete'))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/plugins/messaging/deliverables/deliverable-1?id=deliverable-1&deleteLinkedTasks=true',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
    expect(onUpdated).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
