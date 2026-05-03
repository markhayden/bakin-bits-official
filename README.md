<p align="center">
  <img src="assets/bakin-bits-logo.svg" alt="Bakin Bits" width="240" />
</p>

<p align="center"><em>Official plugins and agent packages for <a href="https://github.com/madeinwyo/bakin">Bakin</a>.</em></p>

<p align="center">
  <a href="https://github.com/madeinwyo/bakin-bits-official/actions/workflows/ci.yml"><img src="https://github.com/madeinwyo/bakin-bits-official/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/madeinwyo/bakin-bits-official"><img src="https://codecov.io/gh/madeinwyo/bakin-bits-official/branch/main/graph/badge.svg" alt="Coverage" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun_%E2%89%A5_1.3.13-black" alt="Bun ≥ 1.3.13" />
</p>

---

## What is Bakin Bits?

**Bakin Bits** is the home for first-party plugins and agent packages that
extend [Bakin](https://github.com/madeinwyo/bakin), a personal AI runtime.
Plugins live here so they can ship and update independently of the Bakin
core binary — a fix to a plugin doesn't require a new core release, and
contributors can land changes without coordinating with the runtime team.

Each package in this monorepo is installed by **git subpath**, not by
publishing to a registry:

```sh
bakin plugins install github:madeinwyo/bakin-bits-official#plugins/<name>
bakin agents  install github:madeinwyo/bakin-bits-official#agents/<name>
```

The `#subpath` syntax tells Bakin to clone this repo, copy just the selected
package directory into the local runtime, and discard everything else. You
get one package, not the whole monorepo.

> Public docs (in progress) — extending Bakin: <https://makinbakin.com/docs/extending/overview/>

## Quickstart

Install the messaging plugin into a running Bakin runtime:

```sh
bakin plugins install github:madeinwyo/bakin-bits-official#plugins/messaging
```

Pin to a released version with the `@<ref>` suffix:

```sh
bakin plugins install github:madeinwyo/bakin-bits-official#plugins/messaging@messaging-v1.0.0
```

## Available packages

### Plugins

| Plugin       | Status   | Description                                                        |
| ------------ | -------- | ------------------------------------------------------------------ |
| `messaging`  | active   | Content planning, publish dates, and prep workflow support.        |
| `projects`   | active   | Project specs, checklists, task links, and project MCP tools.      |
| `_template`  | scaffold | Starter plugin layout for new contributors.                        |

### Agents

| Agent   | Status | Description                                                                                          |
| ------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `patch` | active | Developer agent package — git-isolation skill, dev-discipline knowledge, workspace templates, avatar. |

## Local development

Clone alongside your Bakin checkout so paths line up, then link a plugin
into a running runtime via hot-reload:

```sh
git clone git@github.com:madeinwyo/bakin-bits-official.git
cd bakin-bits-official
bun install

# In your bakin checkout:
BAKIN_DEV_HOTRELOAD=1 bakin start

# Back in this repo:
bakin plugins link ./plugins/_template
```

Before opening a PR, run the same gates CI runs:

```sh
bun typecheck && bun test --isolate && bun lint
```

## Repository layout

```
bakin-bits-official/
├── plugins/      # installable plugin packages (one dir per plugin)
├── agents/       # installable agent packages
├── assets/       # shared brand assets (logo, etc.)
├── test/         # shared test setup (DOM globals)
├── test-sdk/     # mock @bakin/sdk used during local tests
└── types/        # shared ambient TypeScript types
```

## Contributing

New plugins and improvements are welcome. Start from `plugins/_template`,
follow the hot-reload contract, and open a PR against `main`. The full
contributor flow — manifest rules, hot-reload constraints, review focus
areas, and release tagging — is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Found a security issue? Please report it privately per
[SECURITY.md](SECURITY.md), not as a public issue.

## Code of conduct

Participation in this project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE). Plugin and agent-package authors retain
copyright on their contributed work; the MIT license applies to the
repository scaffold and official packages authored by the Bakin core team.
