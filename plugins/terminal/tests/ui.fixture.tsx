import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { terminalRegistration } from '../client-registration'
import { installFixtureSocket } from './fixture-socket'

const session = {
  id: 'demo', title: 'Terminal plugin development', cwd: '/workspace/bakin', program: 'shell', agentId: 'patch',
  owner: { kind: 'agent', id: 'patch' }, generation: 1, inputSequence: 0, cols: 80, rows: 24,
  state: 'running', createdAt: 0, lastActivityAt: 0,
}
const fixture = {
  ...DEFAULT_PLUGIN_UI_FIXTURE, route: '/terminal/demo', randomSeed: 'terminal-ui',
  network: [
    { path: '/api/plugins/terminal/options', status: 200, json: { agents: [{ id: 'patch', name: 'Patch', enabled: true }, { id: 'chef', name: 'Chef', enabled: false }], tasks: [{ id: 'task-1', title: 'Terminal development', agentId: 'patch', projectId: 'project-1' }], defaults: { cwd: '/workspace/bakin', agentId: 'patch' } } },
    { path: '/api/plugins/projects/', status: 200, json: { projects: [{ id: 'project-1', title: 'Bakin' }] } },
    { path: '/api/plugins/terminal/sessions', status: 200, json: { serviceReady: true, sessions: [session] } },
  ],
} as const
installFixtureSocket({ session, snapshot: '$ git status\r\nOn branch feat/terminal-plugin\r\n\r\nWorking tree clean\r\n$ ' })
createRoot(document.getElementById('root')!).render(<PluginUiFixtureHost className="fixed inset-x-0 bottom-0 top-(--bakin-shell-top) [&>[data-bakin-plugin-fixture-page]]:h-full" fixture={fixture} registrations={[terminalRegistration]} />)
