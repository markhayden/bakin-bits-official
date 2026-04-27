/**
 * Page component for the _template plugin.
 *
 * Renders at `/_template` in the shell. Uses only `@bakin/sdk/*`
 * imports — never reach into Bakin internals or other plugin packages.
 */
import type { ReactElement } from 'react'
import { PluginHeader } from '@bakin/sdk/components'

export function TemplatePage(): ReactElement {
  return (
    <div className="p-6 space-y-4">
      <PluginHeader title="Plugin Template" />
      <p className="text-sm text-muted-foreground">
        This is the starter page for new plugins. Replace the contents
        with your real UI; the routing + slot wiring is already plumbed.
      </p>
      <p className="text-sm">
        Server-side, the plugin exposes <code>GET /api/plugins/_template/</code>
        which returns <code>{`{ ok: true, plugin: '_template' }`}</code>.
      </p>
    </div>
  )
}
