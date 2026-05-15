// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ContentTypeOption } from '../../../plugins/messaging/types'
import { __resetContentTypesCache, useContentTypes } from '../../../plugins/messaging/hooks/use-content-types'

const originalEventSource = globalThis.EventSource

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emit(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

function ContentTypeProbe() {
  const contentTypes = useContentTypes()
  return (
    <ul>
      {contentTypes.map((type) => (
        <li key={type.id}>{type.label}</li>
      ))}
    </ul>
  )
}

let contentTypes: ContentTypeOption[] = []
let fetchedUrls: string[] = []

beforeEach(() => {
  __resetContentTypesCache()
  FakeEventSource.instances = []
  fetchedUrls = []
  contentTypes = [{ id: 'blog', label: 'Initial blog', prepLeadHours: 72 }]
  ;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource
  globalThis.fetch = mock(async (url: string) => {
    fetchedUrls.push(url)
    return {
      ok: true,
      json: async () => ({ contentTypes }),
    }
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  __resetContentTypesCache()
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource
  } else {
    delete (globalThis as Partial<typeof globalThis>).EventSource
  }
})

describe('useContentTypes', () => {
  it('refreshes cached content types when messaging settings change over SSE', async () => {
    render(<ContentTypeProbe />)

    await screen.findByText('Initial blog')
    expect(FakeEventSource.instances[0]?.url).toBe('/api/events')

    contentTypes = [{ id: 'blog', label: 'Updated blog', prepLeadHours: 72 }]
    FakeEventSource.instances[0]?.emit({ type: 'plugin:settings-changed', pluginId: 'messaging' })

    await waitFor(() => {
      expect(screen.getByText('Updated blog')).toBeDefined()
    })
    expect(fetchedUrls).toEqual(['/api/plugin-settings/messaging', '/api/plugin-settings/messaging'])
  })

  it('ignores settings change events for other plugins', async () => {
    render(<ContentTypeProbe />)

    await screen.findByText('Initial blog')
    contentTypes = [{ id: 'blog', label: 'Updated blog', prepLeadHours: 72 }]
    FakeEventSource.instances[0]?.emit({ type: 'plugin:settings-changed', pluginId: 'team' })

    await Promise.resolve()
    expect(screen.queryByText('Updated blog')).toBeNull()
    expect(fetchedUrls).toEqual(['/api/plugin-settings/messaging'])
  })
})
