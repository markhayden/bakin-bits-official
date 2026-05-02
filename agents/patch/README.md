# Patch — agent package

Reference agent package for Bakin's developer agent. Builds + maintains API integrations, automation workflows, debugs issues, extends tooling.

## Layout

```
agents/patch/
├── bakin-package.json
├── workspace/                SOUL/IDENTITY/AGENTS/TOOLS templates
├── skills/
│   └── git-isolation/        runtime procedure for Bakin git worktree tools
├── knowledge/
│   └── dev-discipline.md     (default-enabled)
└── assets/                   avatar.jpg + avatar-full.png
```

## Notes

- **`agent.defaultModel: "openai-codex/gpt-5.5"`** — Patch defaults to the current Codex model for development work. Set on fresh install only; the user can change it via the Models UI afterward.
- Single knowledge file: `dev-discipline` — durable principles (build right first time / automate everything / debugging discipline / security first / never deploy without testing / documentation rules / when-to-ask-before-acting checklist).
- Runtime skill: `git-isolation` — teaches Patch to call Bakin's git worktree tools before editing code, status before handoff, and release only when the worktree is safe to clean up.
- AGENTS.md keeps Patch's operational rules portable: no machine-specific paths, no assumed browser profiles, and `date` before inserting timestamps.

## Install

```bash
bakin agents install ./agents/patch
```
