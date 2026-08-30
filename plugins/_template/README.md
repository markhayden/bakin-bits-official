# _template plugin

The official Storybook-first starter for a new Bakin plugin. It demonstrates
the smallest complete server, plugin-owned page, host slot, and browser
conformance workflow while importing only `@makinbakin/sdk/*`.

| Contract | Copyable source |
|---|---|
| Declarative, validated API routes | `index.ts` |
| Hot-reload-safe lifecycle | `index.ts` `activate()` / `onShutdown()` |
| Production route and `home-widget` registration | `client-registration.tsx` |
| Canonical detail, form, state, and card UI | `components/` |
| Deterministic page-and-slot fixture | `tests/ui.fixture.tsx` |
| One-command browser checks | `bakin.ui-test.ts` / `bun run test:ui` |

## Copy this starter

```sh
cp -R plugins/_template plugins/my-plugin
cd plugins/my-plugin
```

Then replace `_template` everywhere, remove `private: true` if the package will
be published, update the manifest/package versions and permissions, and replace
the greeting example with one real domain operation. Plugin IDs must match
`/^[a-z][a-z0-9-]{0,39}$/`; the leading underscore here exists only to mark
this directory as a scaffold that Bakin should not install or publish.

The page uses `registerPlugin({ routes })` because `/_template` is owned by the
plugin. Do not turn it into a `page:/_template` slot: `page:/...` is reserved
for filling routes already owned by the host. Internal navigation uses the
shipped `PluginLink` contract instead of rebuilding URL or history behavior.

## Storybook-first UI contract

Start with the public catalog before adding CSS:

- `Patterns/List and detail pages` owns the page canvas and replaceable state
  region.
- `Forms/Field and form composition` owns labels, descriptions, actions,
  validation, and busy state.
- `States/System feedback` owns loading, recoverable error, and retained
  mutation feedback.
- `Foundation/Card`, `Foundation/Button`, and the layout primitives own the
  bounded content and rhythm.

Import primitives from `/ui`, layout from `/layout`, page recipes from
`/patterns`, and routing from `/navigation`. Never import the frozen
`/components` barrel for new UI, host Tailwind utilities, or Bakin internals.
The host supplies `@makinbakin/sdk/styles.css`; only the standalone browser
fixture imports it, exactly once.

The starter ships no plugin-owned stylesheet: everything it renders is owned
by the public catalog (`Text mono` covers the identifiers the first draft
styled by hand). Add CSS only for domain presentation that the public catalog
does not already own — if that day comes, add a `styles.css`, import it from
`client-registration.tsx`, and scope every rule to
`:where([data-bakin-plugin="_template"])`.

When a genuine domain requirement cannot use a defined Storybook pattern,
give the maintainer a concrete, human-readable explanation naming the
requirement, the closest pattern considered, why it does not fit, and the
smallest accessible exception. An unexplained visual fork fails conformance.

## Install and verify

```sh
bun install
bun run typecheck
bun test
bun run test:ui
```

Install Chromium once on a new development machine:

```sh
bunx playwright install chromium
```

`test:ui` renders the real production page and `home-widget` at 1440×900 and
320×800. It checks CSS ownership, canonical stylesheet identity, horizontal
overflow, axe accessibility, keyboard focus, and browser errors, then writes
HTML, JSON, and screenshots under `test-results/bakin-ui/`.

Against a local Bakin checkout:

```sh
BAKIN_DEV_HOTRELOAD=1 bakin start
bakin plugins link ./
```

All timers, watchers, and sockets belong inside `activate(ctx)`. Track them in
module state and release them in `onShutdown()` so a hot reload cannot leave
the old module running beside the new one.
