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

- `messaging`: brainstorm workspace layout modes with resizable columns and
  tabbed proposal review; plugin version bumped to `2.1.0`.
- `messaging`: API route OpenAPI metadata types (#9).
- `projects`: API route OpenAPI metadata types (#9); declared official
  plugin routes (#7); chat top padding fix (#6); titled-project guard
  before editing (#5); search route declarations (#4); runtime dependency
  declarations (#3).

### Agents

- `patch`: initial agent package added (#10).
- `pixel`: route image generation through the core images plugin
  (`bakin_exec_images_generate`) instead of the raw nano-banana-pro script —
  returns the managed `image_filename` with generation provenance; nano-banana
  retained for edits and multi-image composition (then imported as a managed
  asset). Package version bumped to `0.1.0` (#41).

[Unreleased]: https://github.com/markhayden/bakin-bits-official/commits/main
