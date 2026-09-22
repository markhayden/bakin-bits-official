import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

export default definePluginUiConformance({
  pluginId: 'projects',
  fixtureEntry: './tests/ui.fixture.tsx',
  readySelector: '[data-list-rows][aria-label="Projects"]',
})
