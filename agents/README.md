# Agents

Official Bakin agent packages. Agent packages are separate from plugins:
agents ship identity, workspace templates, skills, knowledge, workflows, and
assets; plugins ship runtime code.

Install an agent package from this monorepo with:

```sh
bakin agents install github:markhayden/bakin-bits-official#agents/<agent-id>
```

## Packages

| Agent | Status | Description |
|---|---|---|
| `patch` | active | Developer agent with git-isolation skill, dev discipline knowledge, and workspace templates. |

## Layout

```
agents/
├── _template/
└── <agent-id>/
    ├── bakin-package.json
    ├── workspace/
    ├── skills/<name>/
    ├── workflows/*.yaml
    ├── knowledge/*.md
    ├── assets/
    └── README.md
```

Agent package directories must be installable by themselves. Repository-level
tests validate manifest basics and ensure contributed paths exist.
