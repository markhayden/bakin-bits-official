# bakin-bits-official

Community plugins for [Bakin](https://github.com/madeinwyo/bakin). Each plugin
ships independently of the Bakin core binary — install via:

```sh
bakin plugins install github:madeinwyo/bakin-bits-official#plugins/<name>
```

The `#subpath` syntax (Bakin 1.x+) clones this monorepo, copies just the
selected plugin directory into `~/.bakin/plugins/<id>/`, and runs the
build pipeline against it.

## Plugins

| Plugin | Status | Description |
|---|---|---|
| _template | scaffold | Starter plugin layout for new contributors |

(More land here as plugins are extracted from `bakin/plugins/` or
contributed fresh.)

## Local development

```sh
# Clone alongside your bakin checkout so paths line up.
git clone git@github.com:madeinwyo/bakin-bits-official.git
cd bakin-bits-official
bun install

# Link a plugin directly into a running bakin's runtime.
BAKIN_DEV_HOTRELOAD=1 bakin start
bakin plugins link ./plugins/_template

# Edit files; saves trigger in-process rebuild + module swap.
```

See `CONTRIBUTING.md` for the full contributor flow, plugin API surface,
and review expectations.

## License

MIT — see `LICENSE`. Plugin authors retain copyright on their contributed
plugins; the `MIT` license applies to the repository scaffold + plugins
authored by the Bakin core team.
