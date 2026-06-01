# Jessica — agent package

Reference agent package for Bakin's research / multi-source discovery agent.

## Layout

```
agents/jessica/
├── bakin-package.json
├── workspace/                 SOUL/IDENTITY/AGENTS/TOOLS templates
├── lessons/
│   ├── source-hierarchy.md    (default-enabled)
│   └── parallel-lanes.md      (opt-in)
└── assets/                    avatar.jpg
```

## Notes

- No bundled OpenClaw skills. Jessica works through the open web + the standard fetch/search tooling her runtime exposes; her competitive advantage is the SOUL/AGENTS prose, not specialized tools.
- Default-enabled lesson: `source-hierarchy` (how to weight different source types when they disagree). The `parallel-lanes` lesson is opt-in for tasks that warrant splitting research into parallel sub-questions.
- The manifest declares no `allowedTools`/`allowedSkills` restrictions (empty) — Jessica relies on her runtime's default tool surface, not a scoped allow-list.

## Install

```bash
bakin agents install ./agents/jessica
```
