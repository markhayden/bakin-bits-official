---
name: release
description: Cut a release for one or more packages (plugin or agent) in this repo — validates version/changelog, tags, pushes one at a time, watches the publish run, and verifies the release. Use when asked to release, tag, or publish a package.
---

# Release a package

Releases are cut by pushing a `<id>-v<semver>` annotated tag; `publish.yml`
does the rest. This skill exists because the failure modes are silent —
follow every step, in order, even for a "quick" release.

## Inputs

One or more package ids (`patch`, `messaging`, …). The version comes from the
package manifest — `plugins/<id>/bakin-plugin.json` or
`agents/<id>/bakin-package.json` — never from the request. If the manifest
version has already been released (tag exists), stop and ask whether to bump.

## Procedure (per package — strictly one at a time)

1. **Preflight** (once, not per package):
   - On `main`, pulled to origin, clean tree. Never tag a branch.
   - `bun install` (stale `file:` test-sdk deps false-fail tests).
   - `bun run test && bun run typecheck && bun run lint` all green.
2. **Validate the package:**
   - Read `version` from the manifest. Tag name is `<id>-v<version>`.
   - `git tag -l <tag>` and `git ls-remote --tags origin <tag>` must both be
     empty. If the tag exists, this version already shipped — ask before
     bumping or retagging.
   - CHANGELOG's `[Unreleased]` section should mention the change; flag it if
     not, but don't block on it.
3. **Tag** with an annotated message — it becomes the release notes verbatim.
   Summarize what changed for THIS package since its last tag
   (`git log <id>-v<prev>..HEAD -- <plugins|agents>/<id>/`), a title line +
   short bullets. Never a lightweight tag (empty release notes).
4. **Push the ONE tag:** `git push origin <tag>`.
   - **NEVER push multiple tags in one `git push`** — more than 3 refs fires
     no workflow events at all, and even 2–3 near-simultaneous runs evict
     each other from the `whiskit-publish` queue (only one run queues;
     `cancel-in-progress: false` protects only the running job).
5. **Watch the run to completion** before touching the next package:
   `gh run list --workflow=publish.yml --branch <tag>` → poll until
   `completed`.
   - `cancelled` → it was evicted: `gh run rerun <id>`, watch again.
   - `failure` → read the log; the usual cause is tag/manifest version
     mismatch. Fix, then delete + re-push the tag
     (`git push origin :refs/tags/<tag>` … retag … push).
   - No run appears within ~2 min → the push event was suppressed; delete
     the remote tag and re-push it alone.
6. **Verify:**
   - `gh release view <tag>` — body is the tag message + Install line.
   - Plugin releases: release has the `.tar.gz`, `.sha256`, and
     `whiskit-artifacts.json`, and is marked Latest.
   - Agent releases: notes-only and NOT marked Latest, and
     `releases/latest/download/whiskit-artifacts.json` still resolves
     (curl -fsSL -o /dev/null; it must not 404).
7. **Repeat from step 2** for the next package only after step 6 passes.

## Report

One line per package: `<tag> → release URL, run green, verified`. Note
anything skipped or flagged (missing changelog entry, rerun needed).
