// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('@bakin/core/main-agent', () => ({
  getMainAgentId: () => 'main',
  tryGetMainAgentId: () => 'main',
  getMainAgentName: () => 'Main',
}))

mock.module('@/components/agent-select', () => ({
  AgentSelect: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => (
    <select aria-label="Quick post agent" value={value} onChange={(event) => onValueChange(event.target.value)}>
      <option value="basil">basil</option>
      <option value="scout">scout</option>
    </select>
  ),
}))

mock.module('@/components/channel-icon', () => ({
  ChannelIcon: ({ channelId }: { channelId: string }) => <span data-testid={`channel-icon-${channelId}`} />,
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...props }: Record<string, unknown>) => (
    <button onClick={onClick as () => void} disabled={disabled as boolean} {...props}>
      {children as React.ReactNode}
    </button>
  ),
}))

mock.module('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}))

mock.module('@/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}))

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

mock.module('../../../plugins/messaging/hooks/use-content-types', () => ({
  useContentTypes: () => [
    { id: 'image', label: 'Image post', assetRequirement: 'image' },
    { id: 'announcement', label: 'Announcement', assetRequirement: 'none' },
  ],
}))

mock.module('@bakin/team/hooks/use-agent-store', () => ({
  useAgentIds: () => ['basil', 'scout'],
}))

mock.module('@bakin/workflows/hooks/use-notification-channels', () => ({
  useNotificationChannels: () => [
    { id: 'general', label: 'General' },
    { id: 'alerts', label: 'Alerts' },
  ],
}))

import { QuickPostButton } from '../../../plugins/messaging/components/quick-post-button'

let createBody: Record<string, unknown> | null = null

beforeEach(() => {
  createBody = null
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/plugins/assets/')) {
      return {
        ok: true,
        json: async () => ({
          assets: [{ filename: 'hero.png', type: 'image/png', description: 'Hero image' }],
        }),
      }
    }
    if (url === '/api/plugins/messaging/deliverables') {
      createBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
})

afterEach(() => cleanup())

describe('QuickPostButton', () => {
  it('creates a Quick Post with an optional existing image asset', async () => {
    const onCreated = mock()
    render(<QuickPostButton onCreated={onCreated} />)

    fireEvent.click(screen.getByText('Quick Post'))
    await waitFor(() => {
      expect(screen.getByLabelText('Quick post title')).toBeDefined()
    })

    fireEvent.change(screen.getByLabelText('Quick post title'), { target: { value: 'Quick image' } })
    fireEvent.change(screen.getByLabelText('Quick post brief'), { target: { value: 'Publish a quick image.' } })
    fireEvent.click(screen.getByText('Attach'))

    await waitFor(() => {
      expect(screen.getByText('hero.png')).toBeDefined()
    })
    fireEvent.click(screen.getByText('hero.png'))
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(createBody).not.toBeNull()
    })
    expect(createBody).toMatchObject({
      planId: null,
      channel: 'general',
      contentType: 'image',
      tone: 'conversational',
      agent: 'basil',
      title: 'Quick image',
      brief: 'Publish a quick image.',
      draft: { imageFilename: 'hero.png' },
    })
    expect(typeof createBody?.publishAt).toBe('string')
    expect(onCreated).toHaveBeenCalled()
  })
})
