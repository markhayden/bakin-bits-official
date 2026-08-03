// @vitest-environment jsdom

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'

mock.module('../../../plugins/projects/components/project-checklist', () => ({
  ProjectChecklist: () => <div data-testid="project-checklist" />,
}))

mock.module('../../../plugins/projects/components/project-editor', () => ({
  ProjectEditor: ({ body }: { body: string }) => <div data-testid="project-editor">{body}</div>,
}))

import { ProjectDetail } from '../../../plugins/projects/components/project-detail'
import { emitPluginEvent } from '@makinbakin/sdk/hooks'
import { act } from '@testing-library/react'

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { fetch?: unknown }).fetch
})

describe('ProjectDetail', () => {
  it('hydrates saved brainstorm messages when reopening a project', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/plugins/projects/proj-1') {
        return {
          ok: true,
          json: async () => ({
            project: {
              id: 'proj-1',
              title: 'Persistent Project',
              status: 'active',
              owner: 'main',
              progress: 0,
              tasks: [],
              assets: [],
              body: '# Persistent Project',
              updated: '2026-05-09T10:00:00.000Z',
              resolvedTasks: {},
              resolvedAssets: [],
              brainstormMessages: [
                {
                  kind: 'user',
                  ts: '2026-05-09T10:00:01.000Z',
                  content: 'What did we decide?',
                },
                {
                  kind: 'assistant',
                  ts: '2026-05-09T10:00:02.000Z',
                  agentId: 'main',
                  content: 'We decided to keep the launch plan focused.',
                },
              ],
            },
          }),
          text: async () => '',
        } as Response
      }
      if (url.endsWith('/history')) {
        return { ok: true, json: async () => ({ history: [] }), text: async () => '' } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-1" onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('What did we decide?')).toBeDefined()
      expect(screen.getByText('We decided to keep the launch plan focused.')).toBeDefined()
    })

    const detail = document.querySelector('[data-slot="project-detail"]')
    const body = document.querySelector('[data-slot="project-detail-body"]')
    expect(detail?.className).toContain('min-w-0')
    expect(screen.getByRole('button', { name: 'Back to projects' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Project actions' })).toBeDefined()
    expect(body?.className).toContain('lg:flex-row')
    expect(body?.className).toContain('pt-bakin-6')
    expect(screen.getByTestId('conversation-panel').getAttribute('data-chrome')).toBe('top-divider')
    expect(screen.getByTestId('conversation-panel').getAttribute('data-auto-focus')).toBe('false')
  })

  it('renders the shared project conversation empty state when no messages exist', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.startsWith('/api/plugins/projects/proj-empty/history')) {
        return { ok: true, json: async () => ({ snapshots: [] }), text: async () => '' } as Response
      }
      if (url === '/api/plugins/projects/proj-empty') {
        return {
          ok: true,
          json: async () => ({
            project: {
              id: 'proj-empty',
              title: 'Quiet Project',
              status: 'active',
              owner: 'main',
              progress: 0,
              tasks: [],
              assets: [],
              body: '# Quiet Project',
              updated: '2026-05-09T10:00:00.000Z',
              resolvedTasks: {},
              resolvedAssets: [],
              brainstormMessages: [],
            },
          }),
          text: async () => '',
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-empty" onBack={() => {}} />)

    const emptyState = await screen.findByTestId('conversation-empty')
    expect(emptyState.textContent).toContain('Brainstorm this project with an agent')
    expect(emptyState.textContent).toContain('every change is snapshotted')
  })

  it('does not render non-image assets in the image lightbox', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/plugins/projects/proj-assets') {
        return {
          ok: true,
          json: async () => ({
            project: {
              id: 'proj-assets',
              title: 'Asset Project',
              status: 'active',
              owner: 'main',
              progress: 0,
              tasks: [],
              assets: [{ assetId: '20260531-brief-abc12345', label: 'Launch brief' }],
              body: '# Asset Project',
              updated: '2026-05-31T10:00:00.000Z',
              resolvedTasks: {},
              resolvedAssets: [
                {
                  assetId: '20260531-brief-abc12345',
                  label: 'Launch brief',
                  type: 'pdf',
                  description: 'Campaign planning PDF',
                },
              ],
              brainstormMessages: [],
            },
          }),
          text: async () => '',
        } as Response
      }
      if (url.endsWith('/history')) {
        return { ok: true, json: async () => ({ history: [] }), text: async () => '' } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-assets" onBack={() => {}} />)

    const assetButton = await screen.findByRole('button', { name: 'Open Launch brief' })
    fireEvent.click(assetButton)

    const dialog = await screen.findByRole('dialog', { name: /Launch brief/ })
    expect(within(dialog).queryByRole('img')).toBeNull()
    expect(within(dialog).getByRole('link', { name: 'Open asset' }).getAttribute('href')).toBe('/assets/20260531-brief-abc12345')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Launch brief/ })).toBeNull()
    })
  })

  it('shows repair actions for missing assets', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/plugins/projects/proj-missing-asset') {
        return {
          ok: true,
          json: async () => ({
            project: {
              id: 'proj-missing-asset',
              title: 'Missing Asset Project',
              status: 'active',
              owner: 'main',
              progress: 0,
              tasks: [],
              assets: [{ assetId: 'deleted-image.png', label: 'Deleted image' }],
              body: '# Missing Asset Project',
              updated: '2026-05-31T10:00:00.000Z',
              resolvedTasks: {},
              resolvedAssets: [
                {
                  assetId: 'deleted-image.png',
                  label: 'Deleted image',
                  type: 'unknown',
                  missing: true,
                },
              ],
              brainstormMessages: [],
            },
          }),
          text: async () => '',
        } as Response
      }
      if (url === '/api/plugins/assets/versioned') {
        return {
          ok: true,
          json: async () => ({
            assets: [
              {
                assetId: '20260531-replacement-abc12345',
                type: 'images',
                description: 'Replacement image',
              },
            ],
          }),
          text: async () => '',
        } as Response
      }
      if (url.endsWith('/history')) {
        return { ok: true, json: async () => ({ history: [] }), text: async () => '' } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-missing-asset" onBack={() => {}} />)

    expect(await screen.findByText("can't find asset")).toBeDefined()
    expect(screen.getByText(/Some attached assets could not be loaded/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Relink Deleted image' }))
    expect(await screen.findByText('Relink asset')).toBeDefined()
    expect(await screen.findByText('20260531-replacement-abc12345')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Detach Deleted image' }))
    expect(await screen.findByRole('dialog', { name: 'Detach asset?' })).toBeDefined()
    expect(screen.getByText(/Bakin can't find this asset/)).toBeDefined()
  })
})


describe('ProjectDetail brainstorm durability (bakin#703)', () => {
  function projectPayload(over: Record<string, unknown> = {}) {
    return {
      project: {
        id: 'proj-703',
        title: 'Durable Project',
        status: 'active',
        owner: 'main',
        progress: 0,
        tasks: [],
        assets: [],
        body: '# Durable Project',
        updated: '2026-07-20T10:00:00.000Z',
        resolvedTasks: {},
        resolvedAssets: [],
        brainstormMessages: [],
        brainstormStreaming: false,
        ...over,
      },
    }
  }

  it('echoes the user message immediately on send — before the 202 lands (the refresh bug)', async () => {
    let resolvePost: () => void = () => {}
    const askCalls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/plugins/projects/proj-703') {
        return { ok: true, json: async () => projectPayload(), text: async () => '' } as Response
      }
      if (url === '/api/plugins/projects/proj-703/ask') {
        askCalls.push(String(init?.body))
        await new Promise<void>((resolve) => { resolvePost = resolve })
        return { ok: true, status: 202, json: async () => ({ ok: true, streaming: true }), text: async () => '' } as Response
      }
      if (url.endsWith('/history')) {
        return { ok: true, json: async () => ({ history: [] }), text: async () => '' } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-703" onBack={() => {}} />)
    const input = await screen.findByTestId('chat-input')
    fireEvent.change(input, { target: { value: 'What next?' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Visible BEFORE the POST resolves — no refresh required.
    await waitFor(() => expect(screen.getByText('What next?')).toBeDefined())
    expect(askCalls).toHaveLength(1)
    await act(async () => { resolvePost() })
  })

  it('rehydrates a mid-flight turn on mount: partial rows + seeded streaming + live bus chunks', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/plugins/projects/proj-703') {
        return {
          ok: true,
          json: async () => projectPayload({
            brainstormMessages: [
              { kind: 'user', ts: '2026-07-20T10:00:01.000Z', content: 'Long question' },
              { kind: 'assistant', ts: '2026-07-20T10:00:02.000Z', agentId: 'main', content: 'Partial reply so far' },
            ],
            brainstormStreaming: true,
          }),
          text: async () => '',
        } as Response
      }
      if (url.endsWith('/history')) {
        return { ok: true, json: async () => ({ history: [] }), text: async () => '' } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-703" onBack={() => {}} />)
    // The incrementally-persisted partial reply is there on return...
    await waitFor(() => expect(screen.getByText('Partial reply so far')).toBeDefined())
    // ...and the still-running turn keeps streaming over the bus.
    act(() => {
      emitPluginEvent({
        event: 'projects.brainstorm.chunk',
        projectId: 'proj-703',
        chunk: { type: 'text', content: 'live continuation' },
      })
    })
    await waitFor(() => expect(screen.getByText(/live continuation/)).toBeDefined())
  })
})
