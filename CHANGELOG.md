# Changelog

All notable changes to this repository are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project follows the principles of [Semantic Versioning](https://semver.org/)
on a per-plugin basis: each plugin tags its own releases as
`<plugin-id>-v<semver>`. The repository itself is not versioned.

## [Unreleased]

### Changed
- Repo hygiene: removed implemented `.claude/specs/`, `plugins/messaging/AUDIT-SUMMARY.md`,
  and `agents/AUDIT.md` (all historical; rules now live in the contract tests). Added root
  `CLAUDE.md` (test/install/release gotchas), `agents/_template/` starter package, an
  "Adding a new agent package" section in CONTRIBUTING, and corrected RELEASE.md's
  multi-tag guidance (>3 tags in one push fires no workflow events; queued publish runs
  evict each other — push one tag at a time).
- All agent packages: second context audit — compressed default-enabled lessons
  (`dev-discipline` 716→379 words, `visual-styles` 571→~390), deduplicated rules
  stated across SOUL/AGENTS/lessons, cut TOOLS.md boilerplate, and fixed stale
  docs (enrich README model claim, missing enrich row in agents README).
  Always-loaded per-session context drops 10–34% per agent. Contract test now
  budgets TOOLS.md (≤120 words) and default-enabled lessons (≤800 words/agent).
  Avatars resized 512×512→256×256 WebP (258 KB→61 KB total; UI renders ≤64px).
  `patch`/`pixel`/`rolo`/`jessica` bumped to `0.7.0`, `enrich` to `0.3.0`.
- `jessica`, `patch`, `pixel`, `rolo`: ship avatars as WebP (`assets/avatar.webp`)
  instead of JPEG — ~50–56% smaller per avatar (e.g. patch 64 KB → 28 KB) at the
  same 512×512. Requires Bakin's dual-format avatar support (markhayden/bakin#339).
  Each package bumped to `0.6.1`.
- `pixel`: cut the image workflow skill + workspace docs over to Bakin's
  versioned-asset model — image tools now return/take a stable `assetId`
  (not a filename), `bakin_exec_images_edit` takes `assetId` (import a loose
  local file first), edits append a new version to the same asset, and Pixel
  reports `assetId` back to the invoking agent. Package bumped to `0.3.0`.
- `rolo`: cut video handoff docs over to managed asset ids — final video files
  should be saved through the asset API and reported as `assetId`, not local
  paths. Package bumped to `0.1.0`.
- `projects`: hard-cut project asset references to managed versioned `assetId`s,
  reject unknown legacy filename attachments, and preview non-image asset types
  without routing them through the image lightbox. Package bumped to `0.1.0`.
- `messaging`: hard-cut image prep prompts to the image asset tools and clean
  deliverable fixtures/docs to use managed asset ids. Package bumped to `0.1.0`.
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
  returns the managed asset id with generation provenance; nano-banana
  retained for edits and multi-image composition (then imported as a managed
  asset). Package version bumped to `0.1.0` (#41).
- `pixel`: adopt `bakin_exec_images_edit` for single-image edits (multi-image
  composition still falls back to the native nano-banana flow, then imports the
  result as a managed asset). Package version bumped to `0.2.0`.
- `jessica`, `pixel`, `rolo`: clear the `allowedTools` allowlist (set to `[]`,
  which the MCP tool policy treats as unrestricted). The per-agent allowlists
  were silently denying legitimate tool calls and forcing native fallbacks —
  more harm than good at this stage. Agents now have unrestricted exec-tool
  access; tighter per-agent scoping will be revisited once a denial surfaces
  to the agent instead of failing silently. (`patch` was already unrestricted.)
  Versions bumped: `jessica` → `0.0.3`, `rolo` → `0.1.0`, `pixel` → `0.3.0`.

[Unreleased]: https://github.com/markhayden/bakin-bits-official/commits/main
