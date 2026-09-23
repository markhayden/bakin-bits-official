import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { ProjectDetail } from '../components/project-detail'

// Synthetic runtime only: no connection to a live agent or project store.
class FixtureEventSource extends EventTarget {
  onmessage = null
  close() {}
}
globalThis.EventSource = FixtureEventSource as unknown as typeof EventSource

const body = '# Weekend plan\n\n## Goal\n\nPlan a short walk and photograph the river.\n\n## Route\n\n- River trail\n- Visitor center'
const project = {
  id: 'sample', title: 'Weekend photography plan', status: 'draft', owner: '',
  progress: 100,
  tasks: [{ id: 'pack', title: 'Prepare camera gear for the weekend and confirm the walking route', checked: true }],
  assets: [], resolvedTasks: {}, resolvedAssets: [], body,
  created: '2026-01-12T10:00:00Z', updated: '2026-01-15T10:00:00Z',
  brainstormMessages: [],
}

function Detail() {
  return <ProjectDetail projectId="sample" onBack={() => {}} />
}

createRoot(document.getElementById('root')!).render(
  <PluginUiFixtureHost
    fixture={{
      ...DEFAULT_PLUGIN_UI_FIXTURE,
      route: '/projects/sample',
      network: [
        { path: '/api/plugins/projects/sample', status: 200, json: { project } },
        { path: '/api/plugins/projects/sample/history', status: 200, json: { history: [
          { ts: '2026-01-14T10:00:00Z', author: 'agent', body: body.replace('and photograph the river.', 'along the river.') },
        ] } },
        { method: 'POST', path: '/api/plugins/projects/sample/brainstorm/seen', status: 200, json: { ok: true } },
      ],
    }}
    registrations={[{ id: 'projects', routes: { '/projects/sample': Detail } }]}
  />,
)
