'use client'

import { useEffect, useState } from 'react'
import { DEFAULT_CONTENT_TYPES, type ContentTypeOption } from '../types'

/**
 * Module-level cache. The initial settings request is shared across mounts,
 * then plugin:settings-changed SSE events force a refresh so content-type
 * edits appear without a browser reload.
 */
let cached: ContentTypeOption[] | null = null
let inFlight: Promise<ContentTypeOption[]> | null = null
let testFetcher: (() => Promise<ContentTypeOption[]>) | null = null

function fetchContentTypes(force = false): Promise<ContentTypeOption[]> {
  if (!force && cached) return Promise.resolve(cached)
  if (inFlight) return inFlight
  inFlight = (testFetcher
    ? testFetcher().then((contentTypes) => ({ contentTypes }))
    : fetch('/api/plugin-settings/messaging')
      .then((r) => (r.ok ? r.json() : null))
  )
    .then((data: { contentTypes?: ContentTypeOption[] } | null) => {
      const list =
        data && Array.isArray(data.contentTypes) && data.contentTypes.length > 0
          ? data.contentTypes
          : DEFAULT_CONTENT_TYPES
      cached = list
      return list
    })
    .catch(() => {
      cached = DEFAULT_CONTENT_TYPES
      return DEFAULT_CONTENT_TYPES
    })
    .finally(() => { inFlight = null })
  return inFlight
}

export function useContentTypes(): ContentTypeOption[] {
  const [types, setTypes] = useState<ContentTypeOption[]>(() => cached ?? DEFAULT_CONTENT_TYPES)

  useEffect(() => {
    let cancelled = false
    fetchContentTypes().then((list) => {
      if (!cancelled) setTypes(list)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let cancelled = false
    const events = new EventSource('/api/events')
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: unknown; pluginId?: unknown }
        if (data.type !== 'plugin:settings-changed' || data.pluginId !== 'messaging') return
        fetchContentTypes(true).then((list) => {
          if (!cancelled) setTypes(list)
        })
      } catch {
        // Ignore malformed events; a later settings event or reload will recover.
      }
    }
    return () => {
      cancelled = true
      events.close()
    }
  }, [])

  return types
}

export function getContentTypeLabel(id: string, types: ContentTypeOption[]): string {
  return types.find((t) => t.id === id)?.label ?? id
}

/** Test-only: reset the module-level cache so tests run with a clean slate. */
export function __resetContentTypesCache(): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) return
  cached = null
  inFlight = null
}

/** Test-only: avoid process-global fetch races in DOM hook tests. */
export function __setContentTypesFetcherForTest(fetcher: (() => Promise<ContentTypeOption[]>) | null): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) return
  cached = null
  inFlight = null
  testFetcher = fetcher
}
