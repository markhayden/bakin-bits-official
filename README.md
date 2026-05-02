# bakin-bits-official

Official Bakin plugins and agent packages distributed independently of the
Bakin core binary.

Install a plugin from this monorepo with:

```sh
bakin plugins install github:madeinwyo/bakin-bits-official#plugins/<name>
```

Install an agent package with:

```sh
bakin agents install github:madeinwyo/bakin-bits-official#agents/<name>
```

The `#subpath` syntax clones this monorepo, copies just the selected package
directory into the local Bakin runtime, and leaves the rest of the repository
out of the installed artifact.

## Plugins

| Plugin | Status | Description |
|---|---|---|
| `messaging` | active | Content planning, publish dates, and prep workflow support. |
| `projects` | active | Project specs, checklists, task links, and project MCP tools. |
| `_template` | scaffold | Starter plugin layout for new contributors. |

## Agents

| Agent | Status | Description |
|---|---|---|
| `patch` | active | Developer agent package with git-isolation skill, dev discipline knowledge, workspace templates, and avatar assets. |

## Local Development

```sh
# Clone alongside your bakin checkout so paths line up.
git clone git@github.com:madeinwyo/bakin-bits-official.git
cd bakin-bits-official
bun install

# Link a plugin directly into a running Bakin runtime.
BAKIN_DEV_HOTRELOAD=1 bakin start
bakin plugins link ./plugins/_template
```

See `CONTRIBUTING.md` for the contributor flow, plugin API surface, and review
expectations.

## License

MIT. Plugin and agent-package authors retain copyright on their contributed
work; the MIT license applies to the repository scaffold and official packages
authored by the Bakin core team.
