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
