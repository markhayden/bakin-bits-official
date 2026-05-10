// @vitest-environment jsdom

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
})
