import { definePluginUiConformance } from '@makinbakin/sdk/testing/ui/conformance'

const surface = process.env.MESSAGING_UI_SURFACE
if (!['calendar', 'brainstorm', 'workspace'].includes(surface ?? '')) throw new Error('Select a Messaging collection fixture')

export default definePluginUiConformance({
  pluginId: 'messaging',
  fixtureEntry: `./tests/${surface}.fixture.tsx`,
  reportDir: `test-results/bakin-ui-${surface}`,
  readySelector: surface === 'calendar' ? '[data-slot="data-table"]' : `[aria-label="${surface === 'brainstorm' ? 'Brainstorm sessions' : 'Content pieces'}"][data-list-rows]`,
})
