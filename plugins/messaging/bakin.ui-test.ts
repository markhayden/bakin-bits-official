import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

export default definePluginUiConformance({
  pluginId: 'messaging',
  fixtureEntry: './tests/ui.fixture.tsx',
  readySelector: '[data-slot="list-row-group"]:first-child [data-list-rows]',
})
