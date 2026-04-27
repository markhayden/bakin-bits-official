# Agents

Reserved for future **agent packages** (a separate primitive from
plugins — agents ship content + identity, plugins ship code).

Agent packages currently live in the bakin core repo at `bakin/agents/`
and the broader `bakin-agent-*` repo family. If/when an "official agents
collection" launches, the layout here will mirror `plugins/`:

```
agents/
├── _template/
└── <agent-id>/
    ├── bakin-package.json   ← kind: "agent" | "skill-pack" | etc.
    ├── workspace/           ← SOUL/IDENTITY/AGENTS/TOOLS templates
    ├── skills/<name>/       ← OpenClaw skills
    ├── workflows/*.yaml
    ├── knowledge/*.md
    └── README.md
```

Out of scope for v1 of `bakin-bits-official`. See
`docs-old/agent-packages-authoring.md` in the bakin repo for the
agent-package authoring contract today.
