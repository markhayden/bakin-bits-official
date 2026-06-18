# Patch — agent package

Reference agent package for Bakin's developer agent. Builds + maintains API integrations, automation workflows, debugs issues, extends tooling.

## Layout

```
agents/patch/
├── bakin-package.json
├── workspace/                SOUL/IDENTITY/AGENTS/TOOLS templates
├── skills/
│   └── git-isolation/        runtime procedure for Bakin git worktree tools
├── lessons/
│   └── dev-discipline.md     (default-enabled)
└── assets/                   avatar.webp
```

## Notes

- No hardcoded model — Patch inherits the Bakin/runtime default. The user can pick a model via the Models UI.
- Lessons: `dev-discipline` (default-enabled) — durable principles (build right first time / automate everything / debugging discipline / security first / never deploy without testing / documentation rules / when-to-ask-before-acting checklist); `api-integration` (opt-in) — deeper integration craft (auth patterns, retries/backoff/idempotency, rate limits, webhook verification, resumable pagination, observability).
- Runtime skill: `git-isolation` — teaches Patch to call Bakin's git worktree tools before editing code, status before handoff, and release only when the worktree is safe to clean up.
- AGENTS.md keeps Patch's operational rules portable: no machine-specific paths, no assumed browser profiles, and `date` before inserting timestamps.

## Install

```bash
bakin agents install ./agents/patch
```
