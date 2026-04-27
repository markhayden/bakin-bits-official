# _template plugin

Starter scaffold for new Bakin plugins. Demonstrates the
`BakinPlugin` contract end-to-end:

- `index.ts` — server entry. Registers a route, a health check, and a
  background timer. Tears the timer down in `onShutdown` so hot reload
  doesn't leak it.
- `client.tsx` — client entry. Calls `registerPlugin({ ... })` as a
  side effect so the shell's PluginHost picks up the nav item + page.
- `components/template-page.tsx` — example page; rendered at
  `/_template` in the shell.

## Copying as a starting point

```sh
cp -R plugins/_template plugins/<my-plugin>
cd plugins/<my-plugin>

# Update bakin-plugin.json (id, name, version, permissions)
# Update package.json (workspace name)
# Replace template-page.tsx + index.ts logic with your own
```

The plugin id must match `/^[a-z][a-z0-9-]{0,39}$/` — lowercase letters
and digits, hyphens allowed mid-id, no underscores. Underscores cause
exec-tool name collisions on the core side (per the manifest validator
in `bakin/packages/host/src/api/plugins/install.ts`).

The leading underscore in `_template` is intentional: it signals
"scaffold, not a real plugin" to the install pipeline. New plugins
must use a regular id.

## Testing locally against a running bakin

```sh
# In your bakin checkout, with hot reload on:
BAKIN_DEV_HOTRELOAD=1 bakin start

# Back here:
bakin plugins link ./
# Save any file → in-process module swap.
```

## Hot-reload contract — read this

The `index.ts` here demonstrates the pattern every plugin must follow:

1. **Side effects in `activate(ctx)`, NOT at module top level.** The
   `setInterval` lives inside activate. A top-level interval would
   leak across reloads (the OLD module's interval keeps firing
   alongside the NEW module's).
2. **Track every side effect in module-scoped state.** The `state`
   object holds the timer handle so `onShutdown` can find it.
3. **Tear down in `onShutdown(ctx)`.** Called by the runtime BEFORE
   the next activate. Errors are logged but never propagate — a
   buggy onShutdown can't brick the dev loop, but it WILL leak if it
   throws.

If you need other lifecycle hooks (`onReady`, `onSettingsChange`),
they're documented in the SDK's `BakinPlugin` type.
