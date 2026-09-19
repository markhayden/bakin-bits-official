import '@makinbakin/sdk/styles.css'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { terminalRegistration } from '../client-registration'

const liveFetch = globalThis.fetch.bind(globalThis)
const fixture = { ...DEFAULT_PLUGIN_UI_FIXTURE, route: '/terminal', network: [] }
function LiveFixture() {
  // This opt-in local integration fixture targets its own isolated backend.
  // Restore real fetch after the child fixture installs its deterministic shell.
  useLayoutEffect(() => { globalThis.fetch = liveFetch }, [])
  return <PluginUiFixtureHost fixture={fixture} registrations={[terminalRegistration]} />
}
createRoot(document.getElementById('root')!).render(<LiveFixture />)
