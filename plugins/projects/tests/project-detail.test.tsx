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
                  id: 'm-user',
                  role: 'user',
                  content: 'What did we decide?',
                  timestamp: '2026-05-09T10:00:01.000Z',
                },
                {
                  id: 'm-assistant',
                  role: 'assistant',
                  agentId: 'main',
                  content: 'We decided to keep the launch plan focused.',
                  timestamp: '2026-05-09T10:00:02.000Z',
                },
              ],
            },
          }),
          text: async () => '',
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ProjectDetail projectId="proj-1" onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('What did we decide?')).toBeDefined()
      expect(screen.getByText('We decided to keep the launch plan focused.')).toBeDefined()
    })
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
})
