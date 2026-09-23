import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

// Diagnostic until the audit findings are fixed; T25 enrolls this in required CI.
export default definePluginUiConformance({
  pluginId: 'projects',
  fixtureEntry: './tests/detail.fixture.tsx',
  reportDir: 'test-results/bakin-ui-detail',
  readySelector: '[data-plan-changed-block]',
})
