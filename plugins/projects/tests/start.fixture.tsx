import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { StartScreen } from '../components/start-screen'

function Start() { return <StartScreen onBack={() => {}} /> }
function Detail() { return <h1>Project created</h1> }

createRoot(document.getElementById('root')!).render(
  <PluginUiFixtureHost
    fixture={{
      ...DEFAULT_PLUGIN_UI_FIXTURE,
      route: '/projects/new',
      randomSeed: 'official-projects-start',
      network: [{ method: 'POST', path: '/api/plugins/projects/', status: 200, json: { ok: true, id: 'created', created: true } }],
    }}
    registrations={[{ id: 'projects', routes: { '/projects/new': Start, '/projects/[id]': Detail } }]}
  />,
)
