# Jessica — agent package

Reference agent package for Bakin's research / multi-source discovery agent.

## Layout

```
agents/jessica/
├── bakin-package.json
├── workspace/                 SOUL/IDENTITY/AGENTS/TOOLS templates
├── workflow-skills/
│   └── research-task.md       structured findings/confidence/sources output
├── lessons/
│   ├── source-hierarchy.md    (default-enabled)
│   └── parallel-lanes.md      (opt-in)
└── assets/                    avatar.jpg
```

## Notes

- No bundled OpenClaw skills. Jessica works through the open web + the standard fetch/search tooling her runtime exposes; her competitive advantage is the SOUL/AGENTS prose, not specialized tools.
- Default-enabled lessons: `source-hierarchy` (how to weight source types when they disagree) and `synthesis-format` (how to present findings — BLUF, inline confidence tagging, citation framing, showing contradictions). The `parallel-lanes` lesson is opt-in for tasks that warrant splitting research into parallel sub-questions.
- The manifest declares no `allowedTools`/`allowedSkills` restrictions (empty) — Jessica relies on her runtime's default tool surface, not a scoped allow-list.
- Workflow skill `research-task` gives research a typed output (`findings`, `confidence`, `sources`, `open_questions`) so a dispatching agent gets parseable, validated findings instead of free-form prose.

## Install

```bash
bakin agents install ./agents/jessica
```
