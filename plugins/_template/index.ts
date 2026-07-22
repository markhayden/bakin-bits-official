/**
 * Server entry — _template plugin.
 *
 * This file demonstrates the modern BakinPlugin contract. Copy this directory
 * to start a new plugin; declarative routes and lifecycle methods are
 * pre-wired for typed docs and hot-reload safety.
 *
 * Hot-reload contract reminder:
 *   - All side effects (timers, watchers, sockets) MUST live inside
 *     `activate(ctx)`. Top-level side effects leak across reloads.
 *   - Tear them down in `onShutdown(ctx)`. The runtime calls it before
 *     the swap. Errors are logged but never propagate.
 *   - Don't capture closures from one activate that outlive it — each
 *     reload runs a fresh `activate` against a fresh module.
 */
import { definePlugin, defineRoute } from '@makinbakin/sdk'
import type { PluginContext } from '@makinbakin/sdk/types'
import { healthHealthy, healthObserved } from '@makinbakin/sdk/utils'
import { z } from 'zod'

interface TemplateState {
  /** Example timer that gets cleared in onShutdown. */
  heartbeat?: ReturnType<typeof setInterval>
}

const state: TemplateState = {}

const plugin = definePlugin({
  id: '_template',
  name: 'Plugin Template',
  version: '0.0.0',

  // Declarative routes are registered before activate(), appear in generated
  // API docs, and keep request validation next to the handler.
  routes: [
    defineRoute({
      path: '/',
      method: 'GET',
      summary: 'Read template plugin status',
      description: 'Returns a small payload proving the plugin is installed and responsive.',
      handler: async () => Response.json({ ok: true, plugin: '_template' }),
    }),
    defineRoute({
      path: '/greet',
      method: 'POST',
      summary: 'Create a template greeting',
      description: 'Demonstrates a validated form mutation through the plugin API.',
      body: z.object({ name: z.string().trim().min(1).max(80) }),
      handler: async (_request, _ctx, parsed) => (
        Response.json({ message: `Hello, ${parsed.body.name}. Your plugin route is working.` })
      ),
    }),
  ],

  async activate(ctx: PluginContext): Promise<void> {
    // Register a health check — surfaces in `bakin doctor`.
    ctx.registerHealthCheck({
      id: 'reachability',
      name: 'Template plugin reachability',
      description: 'Checks that the starter plugin activated and can serve its example API.',
      group: { key: '_template', label: 'Plugin Template' },
      run: async () => healthObserved([healthHealthy({
        key: 'reachability',
        summary: 'The template plugin is loaded and responding.',
      })]),
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
})

export default plugin
