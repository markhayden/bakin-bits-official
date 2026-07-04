# CLAUDE.md

Official Bakin plugins (`plugins/`) and agent packages (`agents/`). Bun
monorepo; plugins build to artifacts, agent packages are plain files installed
by git subpath.

## Commands

```sh
bun run test        # NOT raw `bun test` — the script preloads test/setup-dom.ts;
                    # without it dozens of component tests false-fail
bun run typecheck
bun run lint
bun run build       # compile check; artifacts ship via publish.yml on tags
bun test agents     # agent package contract tests only
```

This repo uses `bun:test`, not vitest/jest — `npx vitest` will not work.

## Gotchas

- **Run `bun install` after pulling.** `@makinbakin/sdk` resolves to the local
  `test-sdk/` stub via a `file:` dependency, and bun does not refresh the
  copied install when the stub changes. Symptom of staleness: tests fail with
  `SyntaxError: Export named 'X' not found in module .../@makinbakin/sdk/...`.
  If a plugin starts using a new SDK export, add it to `test-sdk/` too.
- **Agent workspace files + default-enabled lessons load every agent session.**
  Keep them tight; `agents/package-contract.test.ts` enforces word budgets
  (SOUL ≤250, AGENTS ≤350, TOOLS ≤120, default-enabled lessons ≤800/agent).
  Push depth into opt-in lessons, mechanics into skills/workflow-skills.
- **No hardcoded models in agent packages** — agents inherit the runtime
  default. The only exception is a capability pin (see `MODEL_PIN_EXCEPTIONS`
  in the contract test).

## Releasing

Push a `<id>-v<semver>` **annotated** tag (message = release notes); the
version must match the package manifest. Works for plugins and agent packages.
**Push tags ONE AT A TIME**: >3 tags in one push fires no workflow events at
all, and near-simultaneous pushes evict each other from the publish queue.
Full flow: RELEASE.md.
