import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

/**
 * Real-SDK desktop/mobile conformance for each detail surface and the start
 * screen. PROJECTS_UI_SURFACE picks one: conversation (default), plan,
 * steps, files, start.
 */
const SURFACES = {
  conversation: { fixture: './tests/detail.fixture.tsx', ready: '[data-slot="project-tab-panel"] [data-conv-empty]' },
  plan: { fixture: './tests/detail-plan.fixture.tsx', ready: '[data-md-changed-block]' },
  steps: { fixture: './tests/detail-steps.fixture.tsx', ready: '[aria-label="Project steps"]' },
  files: { fixture: './tests/detail-files.fixture.tsx', ready: '[aria-label="Produced files"]' },
  start: { fixture: './tests/start.fixture.tsx', ready: '[data-projects-start] [data-conv-empty]' },
} as const

const surface = (process.env.PROJECTS_UI_SURFACE ?? 'conversation') as keyof typeof SURFACES
const config = SURFACES[surface]
if (!config) throw new Error(`Unknown PROJECTS_UI_SURFACE: ${surface}`)

export default definePluginUiConformance({
  pluginId: 'projects',
  fixtureEntry: config.fixture,
  reportDir: `test-results/bakin-ui-${surface === 'conversation' ? 'detail' : `detail-${surface}`}`,
  readySelector: config.ready,
})
