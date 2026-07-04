# Releasing a plugin (Whiskit)

This repo ships **prebuilt** plugin artifacts so users can install with no
toolchain — no `bun`, no `node`, no building on their machine. Plugin `dist/`
is **not committed** (it's build output); a release is cut by pushing a tag, and
`.github/workflows/publish.yml` assembles + publishes the artifact.

## TL;DR

```sh
# 1. Bump the version in plugins/<id>/bakin-plugin.json — it MUST match the tag.
# 2. Tag <plugin-id>-v<version> with an annotated message (the release notes).
git tag -a messaging-v0.2.0 -m "Add brainstorm export; fix plan ordering"
git push origin messaging-v0.2.0
```

That's the whole flow. CI does the rest.

## Agent packages

Agent packages (`agents/<id>`) release through the same tag scheme
(`patch-v0.7.0`) and the same workflow, but there is **no artifact**: agent
installs are pure git, so the release is notes-only and validated against
`agents/<id>/bakin-package.json`. Agent releases are never marked `latest` —
the stable `releases/latest/download/whiskit-artifacts.json` redirect must
keep resolving to the newest *plugin* catalog.

```sh
git tag -a patch-v0.7.0 -m "Context audit v2 — leaner always-loaded workspace"
git push origin patch-v0.7.0
```

Consumers install from git, pinnable to the tag:

```sh
bakin agents install github:markhayden/bakin-bits-official#agents/patch          # default branch
bakin agents install github:markhayden/bakin-bits-official@patch-v0.7.0#agents/patch  # pinned
```

## Versioning

- **Source of truth is `plugins/<id>/bakin-plugin.json` → `version`.** The tag
  must agree with it. The workflow reads the manifest and **fails the run** if
  the tag's `-v<semver>` doesn't match — so you can't cut a release named
  `messaging-v0.2.0` that actually ships `0.1.0`.
- **One tag = one plugin.** Tags are `<plugin-id>-v<semver>`
  (`messaging-v0.2.0`, `projects-v0.3.0`, …). Each plugin versions
  independently; a release publishes **only** the tagged plugin.
- **The others carry forward.** Each release's `whiskit-artifacts.json` is a
  complete catalog: the tagged plugin gets a fresh artifact in *this* release,
  and every other plugin's entry is carried forward from the previous catalog
  (pointing at its own older release's artifact). So `releases/latest` always
  has a full index even though plugins release one at a time.

### Releasing multiple plugins at once

Push multiple tags. The publish workflow uses a `concurrency` group
(`whiskit-publish`, `cancel-in-progress: false`), so runs **serialize** — each
one carries forward the previous one's catalog, keeping the index consistent.
There's no "release everything" button by design; you choose exactly what ships.

## Release notes

Release notes come from the **annotated tag message**. Write them when you tag:

```sh
# short note:
git tag -a messaging-v0.2.0 -m "Add brainstorm export; fix plan ordering"

# multi-line note (opens your editor — title + bullets):
git tag -a messaging-v0.2.0

git push origin messaging-v0.2.0
```

The workflow extracts that message and uses it as the GitHub release body, then
appends an `Install:` line. A **lightweight** tag (`git tag messaging-v0.2.0`,
no `-a`) falls back to the tagged commit's message.

GitHub's auto-generated "What's Changed" is intentionally **off**: in a
monorepo with interleaved per-plugin tags, GitHub's "since the previous tag"
diff can pick a *different* plugin's tag as the baseline and produce noisy
cross-plugin notes. Author-written tag messages stay accurate.

Release bodies are editable in the GitHub UI after the fact — cut the release,
then polish if you like.

## What the workflow does

`.github/workflows/publish.yml` (triggered on `*-v*` tags):

1. **Parse + validate tag** — derive `<plugin>`/`<version>`, confirm
   `plugins/<plugin>/` exists, and assert the manifest version == tag version.
2. **Build** — `bun install` + `bun run build` produces `plugins/<id>/dist/`.
3. **Get Bakin** — clones Bakin from source to run `bakin plugins publish`.
   (Switch to a downloaded released binary once a Bakin release ships the
   command.)
4. **Carry forward** — downloads the previous `releases/latest` catalog as the
   starting `whiskit-artifacts.json` (first release starts fresh).
5. **Publish artifact** — `bakin plugins publish` assembles the `.tar.gz`
   (`bakin-plugin.json` + `dist/` + `.whiskit/build.json` provenance) + a
   SHA256 checksum, and merges this plugin's entry into the catalog with URLs
   pinned to **this** tag's release.
6. **Compose release notes** — tag message + install line → `notes.md`.
7. **Create GitHub release** — attaches the artifact, checksum, and
   `whiskit-artifacts.json`; body is `notes.md`; marked `make_latest`.

## How install resolves a release

```sh
bakin plugins install github:markhayden/bakin-bits-official#plugins/messaging
```

Bakin reads `releases/latest/download/whiskit-artifacts.json` (a stable
redirect), finds the `messaging` entry, downloads the pinned artifact + checksum
from whatever release published it, verifies the SHA256, and extracts it into
the runtime. **Nothing builds on the user's machine.**

Pin a specific version with `@<tag>`:

```sh
bakin plugins install github:markhayden/bakin-bits-official#plugins/messaging@messaging-v0.2.0
```

## Pre-release checklist

- [ ] `bun run typecheck && bun run test && bun run lint` pass locally.
- [ ] `plugins/<id>/bakin-plugin.json` `version` bumped.
- [ ] Tag is `<plugin-id>-v<version>` and **matches** that version.
- [ ] Annotated tag message written (these become the release notes).
- [ ] After push: the `Publish plugin artifact` workflow is green and the
      GitHub release has the `.tar.gz`, `.sha256`, and `whiskit-artifacts.json`.

## Troubleshooting

- **Run fails on "Tag '…' is vX but … is version 'Y'"** — bump the manifest to
  match the tag, or delete + retag: `git tag -d <tag> && git push origin :<tag>`
  then re-tag at the right version.
- **Release notes are empty / just the install line** — you pushed a
  lightweight tag and the commit message was empty. Re-tag with `-a -m "…"`, or
  edit the release body in the GitHub UI.
- **Index is missing a plugin** — that plugin has never been released. Its entry
  only appears in the catalog once it's had its own `<id>-v…` tag.
