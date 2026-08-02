import React from 'react'

export const DEFAULT_PLUGIN_UI_FIXTURE = {
  route: '/',
  randomSeed: 'test-sdk',
  network: [],
}

export function PluginUiFixtureHost() {
  return React.createElement('div', { 'data-testid': 'plugin-ui-fixture-host' })
}
