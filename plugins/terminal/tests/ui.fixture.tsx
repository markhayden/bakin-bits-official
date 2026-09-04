import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { terminalRegistration } from '../client-registration'

const session = {
  id: 'demo', title: 'Terminal plugin development', cwd: '/workspace/bakin', program: 'shell', agentId: 'patch',
  owner: { kind: 'agent', id: 'patch' }, generation: 1, inputSequence: 0, cols: 80, rows: 24,
  state: 'running', createdAt: 0, lastActivityAt: 0,
}
const fixture = {
  ...DEFAULT_PLUGIN_UI_FIXTURE, route: '/terminal/demo', randomSeed: 'terminal-ui',
  network: [
    { path: '/api/plugins/terminal/sessions', status: 200, json: { serviceReady: true, sessions: [session] } },
    { path: '/api/plugins/terminal/stream?id=demo', status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: `data: ${JSON.stringify({ type: 'snapshot', session, cursor: 0, data: btoa('$ git status\r\nOn branch feat/terminal-plugin\r\n\r\nWorking tree clean\r\n$ ') })}\n\n` },
  ],
} as const
createRoot(document.getElementById('root')!).render(<PluginUiFixtureHost fixture={fixture} registrations={[terminalRegistration]} />)
