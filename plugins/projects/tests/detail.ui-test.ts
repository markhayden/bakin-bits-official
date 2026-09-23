import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

// Required desktop/mobile read and edit conformance, with the real SDK.
export default definePluginUiConformance({
  pluginId: 'projects',
  fixtureEntry: process.env.PROJECTS_UI_SURFACE === 'edit' ? './tests/detail-edit.fixture.tsx' : './tests/detail.fixture.tsx',
  reportDir: process.env.PROJECTS_UI_SURFACE === 'edit' ? 'test-results/bakin-ui-detail-edit' : 'test-results/bakin-ui-detail',
  readySelector: process.env.PROJECTS_UI_SURFACE === 'edit' ? 'form[aria-label="Edit project"]' : '[data-md-changed-block]',
})
