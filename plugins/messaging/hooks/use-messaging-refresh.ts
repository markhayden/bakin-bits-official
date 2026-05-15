'use client'

import { useEffect } from 'react'

export function useMessagingContentRefresh(refresh: () => void, prefixes: string[]): void {
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const events = new EventSource('/api/events')
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { file?: unknown }
        const file = typeof data.file === 'string' ? data.file : ''
        if (file && prefixes.some((prefix) => file.startsWith(prefix))) refresh()
      } catch {
        // Ignore malformed event payloads; the next explicit refresh will recover.
      }
    }
    return () => events.close()
  }, [prefixes, refresh])
}
