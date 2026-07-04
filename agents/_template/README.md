# _template — agent package skeleton

Copy this directory to start a new agent package:

```sh
cp -R agents/_template agents/my-agent
```

Then:

1. Fill in `bakin-package.json` (id, name, description, identity, tags). Do
   NOT set `agent.defaultModel` unless the agent needs a capability the
   runtime default lacks — the contract test enforces this.
2. Write the four `workspace/` files. They load **every session**; budgets
   are CI-enforced (SOUL ≤250w, AGENTS ≤350w, TOOLS ≤120w).
3. Add depth as `lessons/*.md` (frontmatter: `title`, `tags`,
   `defaultEnabled`). Default-enabled lessons also load every session and
   are budgeted (≤800w total per agent) — keep most lessons opt-in. List
   default-enabled ones in `install.enableLessons` (CI checks they match).
4. Add mechanics (tool call patterns, curl, ffmpeg) as `skills/<name>/SKILL.md`
   or `workflow-skills/*.md` — these load on demand, not per session.
5. Add `assets/avatar.webp` — 256×256 WebP (the UI renders ≤64px).
6. Validate with `bun test agents`, smoke with
   `bakin agents install ./agents/my-agent`.

Directories starting with `_` are ignored by the contract tests.
