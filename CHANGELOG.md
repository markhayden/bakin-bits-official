# Changelog

All notable changes to this repository are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project follows the principles of [Semantic Versioning](https://semver.org/)
on a per-plugin basis: each plugin tags its own releases as
`<plugin-id>-v<semver>`. The repository itself is not versioned.

## [Unreleased]

### Changed
- Reset official plugin and agent package versions to `0.0.1` for the Bakin `0.0.1` release train.
- Allow Bakin `0.0.1-rc.1` and newer in official plugin and agent package compatibility ranges.
- Align official plugin SDK peer dependency ranges with the `@makinbakin/sdk` release candidate.

### Added
- OSS governance files: `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `CHANGELOG.md`, GitHub issue and PR templates.
- Brand logo asset at `assets/bakin-bits-logo.svg`.

### Plugins

- `messaging`: API route OpenAPI metadata types (#9).
- `projects`: API route OpenAPI metadata types (#9); declared official
  plugin routes (#7); chat top padding fix (#6); titled-project guard
  before editing (#5); search route declarations (#4); runtime dependency
  declarations (#3).

### Agents

- `patch`: initial agent package added (#10).

[Unreleased]: https://github.com/markhayden/bakin-bits-official/commits/main
