# Contributing

This repository hosts community plugins for Bakin. Each plugin lives at
`plugins/<id>/` as a self-contained directory: manifest, source, tests,
docs, dist (generated). Plugins are independent — there are no shared
dependencies beyond `@bakin/sdk`.

## Prerequisites

- **Bun** ≥ 1.3.13 (matches Bakin core; pinned in `.bun-version`)
- A working **Bakin checkout** alongside this repo for end-to-end testing
  (clone `madeinwyo/bakin` as a sibling of this repo)

## Repo layout

```
bakin-bits-official/
├── plugins/
│   ├── _template/          ← copy this when starting a new plugin
│   ├── messaging/          ← extracted from bakin/plugins/messaging
│   └── projects/           ← extracted from bakin/plugins/projects
├── agents/                 ← reserved for future agent packages
├── package.json            ← workspaces: plugins/*
├── tsconfig.json
├── eslint.config.mjs
└── .github/workflows/ci.yml
```

## Adding a new plugin

1. **Copy the template.**
   ```sh
   cp -R plugins/_template plugins/my-plugin
   cd plugins/my-plugin
   ```
2. **Update the manifest.** Edit `bakin-plugin.json`:
   - `id` must match `/^[a-z][a-z0-9-]{0,39}$/` (lowercase + hyphens, no
     underscores; underscores cause exec-tool name collisions on the
     core side).
   - `name`, `description`, `version`, `permissions` (declare every
     capability the plugin uses; runtime gate added in the future).
3. **Update `package.json`.** Set the workspace name (e.g.
   `@bakin-bits/my-plugin`), keep `@bakin/sdk` in `peerDependencies`.
4. **Implement.** `index.ts` exports a `BakinPlugin` with `activate(ctx)`
   and (recommended) `onShutdown(ctx)`. `client.tsx` calls
   `registerPlugin({ id, navItems, routes })` for plugin-owned pages.
   Use `slots` only for extension surfaces inside another page.
5. **Test.**
   ```sh
   cd ../..
   bun test plugins/my-plugin/tests
   ```
6. **Smoke against a real bakin.**
   ```sh
   # In your bakin checkout, with hot-reload on:
   BAKIN_DEV_HOTRELOAD=1 bakin start
   # Back here:
   bakin plugins link ./plugins/my-plugin
   ```

## Designing for hot reload

The Bakin runtime hot-reloads linked plugins via in-process module
swap. This places real constraints on plugin code:

- **All side effects (timers, watchers, sockets) MUST live inside
  `activate(ctx)`.** Top-level `setInterval`, `process.on`, `fs.watch`
  etc. leak across reloads — the OLD module's listeners keep firing
  alongside the NEW module's.
- **Tear them down in `onShutdown(ctx)`.** The runtime calls it before
  the swap. Errors are logged but never propagate (a buggy
  `onShutdown` cannot brick the dev loop).
- **Don't capture closures from one activate that outlive it.** Each
  reload runs a fresh `activate` against a fresh module; references
  inside webhooks, in-flight tasks, etc. should re-read on every call.

The `_template` plugin demonstrates the contract — use it as a
starting point.

## Submitting a change

1. Fork + branch: `git checkout -b feat/my-plugin`
2. Make changes; ensure CI passes locally:
   ```sh
   bun typecheck
   bun test --isolate
   bun lint
   ```
3. Open a PR against `main`. Include:
   - What the plugin does (one sentence)
   - Test plan (how a reviewer can smoke it locally)
   - Screenshot if it touches UI
4. Reviews focus on the four areas: hot-reload compliance, permissions
   accuracy, error handling, and SDK boundary discipline (no imports
   from outside `@bakin/sdk/*`).

## Releasing a plugin

Tag in this repo using the `<plugin-id>-v<semver>` convention:

```sh
git tag messaging-v1.0.0
git push origin messaging-v1.0.0
```

Bakin's `bakin plugins install` and `bakin plugins upgrade` round-trip
against tags via the install source's `@<ref>` syntax (issue #177
tracks adding `--ref` to `install`; until then upgrade flow honors the
installed-time `ref`).
