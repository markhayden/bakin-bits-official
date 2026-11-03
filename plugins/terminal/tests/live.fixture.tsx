import '@makinbakin/sdk/styles.css'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { emitPluginEvent, useToastStore } from '@makinbakin/sdk/hooks'
import { terminalRegistration } from '../client-registration'
import { TerminalAttentionProvider } from '../components/attention-provider'
import { claimOnce } from '../components/attention'

const liveFetch = globalThis.fetch.bind(globalThis)
const fixture = { ...DEFAULT_PLUGIN_UI_FIXTURE, route: (window.location.pathname === '/' ? '/terminal' : window.location.pathname) + window.location.search, network: [] }
function LiveFixture() {
  // This opt-in local integration fixture targets its own isolated backend.
  // Restore real fetch after the child fixture installs its deterministic shell.
  useLayoutEffect(() => { globalThis.fetch = liveFetch }, [])
  return <><TerminalAttentionProvider /><PluginUiFixtureHost className="fixed inset-x-0 bottom-0 top-(--bakin-shell-top) [&>[data-bakin-plugin-fixture-page]]:h-full" fixture={fixture} registrations={[terminalRegistration]} /></>
}
// The host's event stream, as the preview serves it: plugin events reach the provider (the nav-badge slot's).
new EventSource('/__events').onmessage = (message) => { emitPluginEvent(JSON.parse(message.data as string) as Record<string, unknown>) }
// For the attention browser test: the toasts raised in this page.
;(window as unknown as { __toasts(): string[] }).__toasts = () => useToastStore.getState().toasts.map((toast) => String(toast.id))
createRoot(document.getElementById('root')!).render(<LiveFixture />)
// For the attention browser test: the cross-tab claim, raced from several pages.
;(window as unknown as { __claimOnce: typeof claimOnce }).__claimOnce = claimOnce
