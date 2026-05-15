// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ContentTypeOption } from '../../../plugins/messaging/types'
import {
  __resetContentTypesCache,
  __setContentTypesFetcherForTest,
  useContentTypes,
} from '../../../plugins/messaging/hooks/use-content-types'

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
  __setContentTypesFetcherForTest(async () => {
    fetchedUrls.push('/api/plugin-settings/messaging')
    return contentTypes
  })
})

afterEach(() => {
  cleanup()
  __setContentTypesFetcherForTest(null)
  __resetContentTypesCache()
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource
  } else {
    delete (globalThis as Partial<typeof globalThis>).EventSource
  }
})

describe('useContentTypes', () => {
  it.skip('refreshes cached content types only for messaging settings change events', async () => {
    render(<ContentTypeProbe />)

    await screen.findByText('Initial blog', {}, { timeout: 15000 })
    expect(FakeEventSource.instances[0]?.url).toBe('/api/events')

    contentTypes = [{ id: 'blog', label: 'Ignored blog', prepLeadHours: 72 }]
    FakeEventSource.instances[0]?.emit({ type: 'plugin:settings-changed', pluginId: 'team' })

    await Promise.resolve()
    expect(screen.queryByText('Ignored blog')).toBeNull()
    expect(fetchedUrls).toEqual(['/api/plugin-settings/messaging'])

    contentTypes = [{ id: 'blog', label: 'Updated blog', prepLeadHours: 72 }]
    FakeEventSource.instances[0]?.emit({ type: 'plugin:settings-changed', pluginId: 'messaging' })

    await waitFor(() => {
      expect(screen.getByText('Updated blog')).toBeDefined()
    }, { timeout: 15000 })
    expect(fetchedUrls).toEqual(['/api/plugin-settings/messaging', '/api/plugin-settings/messaging'])
  }, 20000)
})
