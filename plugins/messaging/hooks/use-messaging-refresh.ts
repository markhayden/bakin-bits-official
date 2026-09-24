import { usePluginEvent } from '@makinbakin/sdk/hooks'

/** File invalidation and connection recovery share the host's single stream. */
export function useMessagingContentRefresh(refresh: () => void, prefixes: string[]): void {
  usePluginEvent('bakin.file.changed', (event) => {
    const file = typeof event.file === 'string' ? event.file : ''
    if (prefixes.some((prefix) => file.startsWith(prefix))) refresh()
  })
  usePluginEvent('bakin.reconcile', refresh)
}
