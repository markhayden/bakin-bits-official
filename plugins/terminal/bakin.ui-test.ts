import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'
export default definePluginUiConformance({
  pluginId: 'terminal', fixtureEntry: './tests/ui.fixture.tsx', readySelector: '[data-terminal-ui-ready]',
})
