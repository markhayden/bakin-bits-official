import '@makinbakin/sdk/styles.css'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { terminalRegistration } from '../client-registration'

const liveFetch = globalThis.fetch.bind(globalThis)
const fixture = { ...DEFAULT_PLUGIN_UI_FIXTURE, route: (window.location.pathname === '/' ? '/terminal' : window.location.pathname) + window.location.search, network: [] }
function LiveFixture() {
  // This opt-in local integration fixture targets its own isolated backend.
  // Restore real fetch after the child fixture installs its deterministic shell.
  useLayoutEffect(() => { globalThis.fetch = liveFetch }, [])
  return <PluginUiFixtureHost className="fixed inset-x-0 bottom-0 top-(--bakin-shell-top) [&>[data-bakin-plugin-fixture-page]]:h-full" fixture={fixture} registrations={[terminalRegistration]} />
}
createRoot(document.getElementById('root')!).render(<LiveFixture />)
