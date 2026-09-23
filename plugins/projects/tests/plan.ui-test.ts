import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

export default definePluginUiConformance({
  pluginId: 'projects',
  fixtureEntry: './tests/plan.fixture.tsx',
  reportDir: 'test-results/bakin-ui-plan',
  readySelector: '[data-plan-layout-checked]',
})
