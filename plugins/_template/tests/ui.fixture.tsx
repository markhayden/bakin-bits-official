import '@makinbakin/sdk/styles.css'

import { createRoot } from 'react-dom/client'
import {
  DEFAULT_PLUGIN_UI_FIXTURE,
  PluginUiFixtureHost,
} from '@makinbakin/sdk/testing/ui'
import { templateRegistration } from '../client-registration'

const fixture = {
  ...DEFAULT_PLUGIN_UI_FIXTURE,
  route: '/_template',
  randomSeed: 'official-template-ui',
  network: [
    {
      path: '/api/plugins/_template/',
      status: 200,
      json: { ok: true, plugin: '_template' },
    },
    {
      method: 'POST',
      path: '/api/plugins/_template/greet',
      status: 200,
      json: { message: 'Hello, Plugin builder. Your plugin route is working.' },
    },
  ],
} as const

createRoot(document.getElementById('root')!).render(
  <PluginUiFixtureHost
    fixture={fixture}
    registrations={[templateRegistration]}
    slots={[{ name: 'home-widget', label: 'Home widget contribution' }]}
  />,
)
