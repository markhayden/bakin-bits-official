import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

export default definePluginUiConformance({
  pluginId: '_template',
  fixtureEntry: './tests/ui.fixture.tsx',
  readySelector: '[data-template-ui-ready]',
})
