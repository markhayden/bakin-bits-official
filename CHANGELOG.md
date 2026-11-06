# Changelog

All notable changes to this repository are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project follows the principles of [Semantic Versioning](https://semver.org/)
on a per-plugin basis: each plugin tags its own releases as
`<plugin-id>-v<semver>`. The repository itself is not versioned.

## [Unreleased]

### Changed
- `projects` (0.14.0): **instant start + the shaping interview.** The start
  screen opens the project the moment the create is written; the first turn
  starts on the server, detached, behind one fenced start protocol
  (counted attempts, a fence token, a bounded context build, a Retry route
  `POST /:projectId/kickoff`, a 30 s kickoff pump, per-project boot
  dispatch), and the project page shows "Starting the conversation…" or an
  honest "hasn't started yet" with Retry — never a spinner that outlives the
  request. Starter chips are complete prompts; the create times out at 10 s
  and retries with the same request id. The lead now runs a shaping
  interview over a brief seeded into the plan body (goal, success, scope,
  constraints, open questions, plan), at most one card per turn with a
  recommendation, drafting once the blocking gaps close and carrying the
  rest as labelled assumptions; "Start project" says when the brief still
  lists open questions and offers "Continue shaping". Lock bodies are
  synchronous by type; the dead per-request SSE transport hook is gone.
  The create's request id no longer needs a secure origin: over Tailscale
  (plain `http://<host>:3737`) `crypto.randomUUID` does not exist, and the
  send threw before the request left the browser, leaving the composer on
  "Sending…" forever — every client-minted id (the create, checklist
  mutations, upload chips) now comes from one helper that builds a v4 from
  `getRandomValues` there, and anything that throws before the request
  leaves surfaces as an error with the text kept. A reload mid-create shows
  the latest text and lead again under an "unconfirmed send" notice, and the
  retry keeps the original lead and message with the edit as the draft.
  The lead is told the question card adds "Not sure — help me choose" and
  an own-answer field by itself, so it never offers a duplicate "Help me
  choose" or "other" option (bakin's card now has one text field).
  The docked conversation is resizable by dragging its page-facing edge
  (the kit rail's grab bar; width persisted, 280px minimum), and the Files
  tab shows one "No files yet" empty state with the attach action instead
  of one per group.

### Fixed
- `projects` (0.12.1): the manifest no longer declares the removed
  `/projects/[id]/edit` route.

### Changed
- `terminal` (0.4.0, **breaking**; requires Bakin `>=0.0.1-rc.45`): the
  multi-device rework. Every viewer, agent read and saved final screen now
  comes from one path — one tmux control-mode client per session feeding a
  server replica — and browsers stream it over a WebSocket; the old PTY
  bridge, SSE output stream, POST input and the agent `resize` operation are
  gone. Sessions run only on Bakin's managed tmux 3.7c (no Homebrew
  fallback); apply the service update after upgrading. Setup refuses while
  sessions run; Terminal's **Apply update** confirmation lists the live
  sessions and can end them first.
  - **Sizing:** one screen sizes a session at a time ("Fit to this device";
    "Back to …" returns it); the others fit the width and pan. Agents never
    resize.
  - **Terminal apps:** `bakin terminal new | attach | ls --as human`
    continues a session in Ghostty or any terminal (and back), with a small
    `C-b` key table; a terminal app can size the session.
  - **Phones:** a key bar and key sheet, a compose sheet for dictation and
    long edits, native scrollback and scrolling that follow the program,
    Copy text, tap-to-copy for program clipboard offers, and full screen.
  - **Attention:** Claude Code and Codex sessions show Needs you / Your turn
    / Working (through hooks Bakin passes at launch; Codex asks to trust them
    once — Bakin never bypasses that), bells, and activity; the Terminal nav
    badge counts unseen sessions that want you; each new Needs you or Your
    turn, and each bell, toasts in visible tabs and sends one OS notification
    per browser where IndexedDB works (subject to notification and focus
    rules).
  - **Images:** pasted, dropped or picked images join the compose draft and
    reach Claude Code and Codex as attached images (a shell gets quoted
    paths); kept privately and deleted with the session's history.
  - Saved final screens for ended sessions (best effort; an ended session
    says when its screen was not saved); Active / Completed / All / Needs
    review views with sortable columns, Last activity among them.
- `messaging` (0.12.3), `projects` (0.13.1): every dispatched `bakin`
  CLI command declares its complete `args` (positionals plus every flag,
  generated from the exec tool's own schema). Bakin's next release parses
  plugin CLI arguments strictly from these declarations: strings stay literal
  (no comma-splitting or JSON coercion), and unknown flags and extra arguments
  are refused (markhayden/bakin#1028). Current Bakin ignores the field, so
  install these before upgrading Bakin. A drift test pins each declaration to
  its exec tool's zod parameters.
- `projects` (0.12.0, requires Bakin `>=0.0.1-rc.45`): the projects revamp
  (Bakin `.claude/specs/projects-revamp.md`).
  New projects start from a conversation, not a form: `/projects/new` asks
  what is on your mind, and the first send creates the project idempotently
  and starts the lead's first turn. The detail page is Conversation · Plan ·
  Steps · Files tabs with the conversation docked beside the others; the
  right rail, status picker, `/projects/:id/edit` route and 4-field draft
  are gone. The lead shapes the project one question card at a time,
  names it, and drafts the plan once it is clear. Agents can no longer
  change status, overwrite a title you typed, or delete steps or projects
  (`bakin_exec_projects_remove_item` and `_delete` and their CLI commands
  are removed; `status` is gone from `_update`/`_apply_plan`; REST mutations
  without the operator declaration get the same agent rules). Linked steps complete from their board task.
  Plan revisions drive a "Plan updated" notice; Files lists what the
  project's tasks produced. The dead `defaultStatus` and
  `autoPromoteThreshold` settings are removed. Requires an SDK with
  structured questions and the conversation-width `PageAside` rail.
- `messaging` (0.12.2), `terminal` (0.3.4): require Bakin `>=0.0.1-rc.42`.
  Both client bundles are built for the `react19-sdk-focused-v2` contract
  (zod host-provided, markhayden/bakin#948), which rc.41 does not serve;
  rc.41 hosts keep messaging 0.12.0 / terminal 0.3.2 through the artifact
  index's contract check.
- `terminal` (0.3.3), `ocr` (0.1.1), `transcribe` (1.0.1): archive-shipped
  binaries pin their extracted member with `archive.extractedSha256`
  (tmux, ocrit, parakeet-cpp-transcribe), computed from freshly downloaded,
  archive-verified releases. Bakin will check the extracted binary against
  this pin before running or installing it, and the binary on disk against
  it in every readiness and Health scan — not just the download
  (markhayden/bakin#898 D);
  until then the field is ignored, so these install on current Bakin.
  Reinstall all three before running a Bakin build with the strict check.
  The tmux mirror workflow now prints the extracted pin in its manifest
  snippet, and both contract tests require it for every archive download.
- `projects` (0.11.4), `terminal` (0.3.2): rebuilt for Bakin rc.41's plugin
  artifact contract (`react19-sdk-focused-v1`, markhayden/bakin#971). The
  previous artifacts were built for `react19-sdk-makinbakin-v2`, which rc.41
  reports as "needs a compatible update". Require Bakin and `@makinbakin/sdk`
  `>=0.0.1-rc.41`. Projects carries the unreleased dependency sweep (0.11.3);
  Terminal also ships its unreleased mobile controls and accelerated rendering
  (0.3.0, #114, which needs rc.41's keyboard-aware workspace inputs) and the
  sweep (0.3.1).
- `messaging` (0.12.0): workflow gate decisions carry honest provenance
  (markhayden/bakin#898 H). Routes pass `approvalProvenanceFromRequest(req)`
  to `workflows.approveGate`/`rejectGate` (no more `'mark'` default approver;
  the drawer declares the operator), agent tools pass an agent provenance,
  and the bridge checks the hook's `success` — a refused decision restores
  the Deliverable and plan. Agents can no longer approve or reject
  workflow-backed Deliverables even under `agentDeliverableApprovalPolicy:
  allowed` (bare-task Deliverables unchanged). Gate events are read from
  `provenance`. Requires Bakin and `@makinbakin/sdk` `>=0.0.1-rc.41`, the
  planned first release containing the Bakin change; publish after it.
- `messaging` (0.11.8), `projects` (0.11.3), `terminal` (0.3.1): dependency
  sweep in lockstep with Bakin #760 — zod `~4.6.5` (the SDK's public types
  carry zod's minor, so the tilde pin must match the host), lucide-react 1.51
  (canonical icon names; lucide 1.x dropped the Twitter/Instagram/Slack brand
  glyphs, so messaging's channel icons are now generic), js-yaml 5 (named
  imports, `quoteStyle` replaces `quotingType`, empty frontmatter no longer
  throws), TypeScript 6 (`types: ["bun"]` + ambient `*.css` module in the
  template and terminal), ESLint 10, Playwright 1.63 with the matching CI
  image. No behavior change beyond the icon glyphs.
- `messaging` (0.11.7), `projects` (0.11.2): retain and reconcile navigation
  state and use green unread-only conversation indicators. Require Bakin and
  `@makinbakin/sdk` `>=0.0.1-rc.39`, the planned first release containing
  markhayden/bakin#933; publish these plugin versions after that host release.
  CI verifies against the merged prerequisite commit before it is released.
- `projects` (0.11.1), `messaging` (0.11.6), `terminal` (0.1.3): require Bakin
  and `@makinbakin/sdk` `>=0.0.1-rc.36` — the host release carrying the shared
  table-first collections, form controls, and staged-editing contracts these
  versions were verified against. Older hosts are refused at install with the
  reason instead of loading a plugin built for kit contracts they lack.

### Added
- Four capability packs, the official lane for markhayden/bakin#687: `github`
  (issues/PRs/CI runs through the `gh` CLI, optional token), `google-workspace`
  (Gmail/Calendar/Drive/Sheets/Docs through the open-source `gog` CLI),
  `notion` (search, read, and write a workspace over the REST API), and
  `office-docs` (read and write real `.docx`/`.xlsx` locally via `mammoth`,
  `docx`, and `exceljs`). Chosen after surveying ClawHub's top 40 skills, which
  are overwhelmingly unlicensed prose that assumes a CLI already exists — so
  these are Bakin-authored and supply the install leg the hub skills lack.
  Binaries the packs cannot pin reproducibly are declared as PATH prerequisites
  with a help link rather than mirrored, keeping readiness honest without
  taking on the re-cut treadmill of hosting third-party releases.
- `skill-porter` pack: supersedes the floor prompt core ships for
  `bakin skills map`, teaching the mapping agent where bundles actually hide
  credentials and binaries, which env vars are configuration rather than
  secrets, and why it must never propose a secret slot itself.
- `packs/pack-contract.test.ts`: packs were the one published package kind with
  no contract coverage. Validates manifest shape, that every declared skill
  exists with Agent-Skills frontmatter, that pinned binaries carry an https URL
  and a real sha256, that npm deps are pinned exactly, and that declared
  secrets bind to a slot Bakin's injection layer will actually honour — the
  last rule caught `notion` shipping an unbindable `notion.token`.
- CI guardrails for three recurring failure modes: a `test-sdk` stub drift test
  (every `@makinbakin/sdk` import in `plugins/` must exist in the stub), a PR
  version-bump check (changed package ⇒ bumped manifest version), and avatar
  budgets in the agent contract tests (≤30 KB, ≤256px).
- `patch`: `dev-task` workflow skill — typed step output (`deliverable` PR/branch,
  `summary`, `tests_passed`), matching the workflow-skill pattern of pixel/rolo/jessica.
  Package bumped to `0.8.0`.
- `.claude/skills/release/`: repo skill that walks a release end-to-end — version/tag
  validation, annotated tagging, one-tag-at-a-time pushes, publish-run watching with
  eviction recovery, and post-release verification.

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
