/**
 * Server entry — _template plugin.
 *
 * This file demonstrates the BakinPlugin contract. Copy this directory
 * to start a new plugin; the lifecycle methods below are pre-wired for
 * hot-reload safety.
 *
 * Hot-reload contract reminder:
 *   - All side effects (timers, watchers, sockets) MUST live inside
 *     `activate(ctx)`. Top-level side effects leak across reloads.
 *   - Tear them down in `onShutdown(ctx)`. The runtime calls it before
 *     the swap. Errors are logged but never propagate.
 *   - Don't capture closures from one activate that outlive it — each
 *     reload runs a fresh `activate` against a fresh module.
 */
import type { BakinPlugin, PluginContext } from '@bakin/sdk/types'

interface TemplateState {
  /** Example timer that gets cleared in onShutdown. */
  heartbeat?: ReturnType<typeof setInterval>
}

const state: TemplateState = {}

const plugin: BakinPlugin = {
  id: '_template',
  name: 'Plugin Template',
  version: '0.0.0',

  async activate(ctx: PluginContext): Promise<void> {
    // Register a route under /api/plugins/_template/.
    ctx.registerRoute({
      path: '/',
      method: 'GET',
      description: 'Returns a hello payload — proves the plugin is live.',
      handler: async () => Response.json({ ok: true, plugin: '_template' }),
    })

    // Register a health check — surfaces in `bakin doctor`.
    ctx.registerHealthCheck({
      id: 'reachability',
      name: 'Template plugin reachability',
      run: async () => [
        {
          check: '_template.reachability',
          status: 'ok' as const,
          message: 'Plugin is loaded and responding',
          autoFixable: false,
        },
      ],
    })

    // Example: a side effect that survives hot reload because it's
    // started here and stopped in onShutdown.
    state.heartbeat = setInterval(() => {
      // Production plugins would do real work here. For the template,
      // we just emit a low-volume audit row.
      ctx.activity.audit('heartbeat', 'system', { ts: Date.now() })
    }, 60_000)
  },

  async onShutdown(): Promise<void> {
    if (state.heartbeat) {
      clearInterval(state.heartbeat)
      state.heartbeat = undefined
    }
  },
}

export default plugin
