# Agents

Official Bakin agent packages. Agent packages are separate from plugins:
agents ship identity, workspace templates, skills, lessons, workflows, and
assets; plugins ship runtime code.

Install an agent package from this monorepo with:

```sh
bakin agents install github:markhayden/bakin-bits-official#agents/<agent-id>
```

## Packages

| Agent | Status | Description |
|---|---|---|
| `patch` | active | Developer agent with git-isolation skill, dev discipline lessons, and workspace templates. |
| `pixel` | active | Image artist agent with visual prompt lessons, image-generation workflow skills, and workspace templates. |
| `rolo` | active | Video producer agent with video/audio craft lessons and declared Runway/ElevenLabs runtime secrets. |
| `jessica` | active | Research agent with source-hierarchy lessons and evidence-gathering workspace templates. |
| `enrich` | active | Single-purpose vision utility for Bakin's asset enrichment pipeline — no tools, JSON-only replies. |

## Layout

```
agents/
├── _template/                  copy this to start a new agent package
└── <agent-id>/
    ├── bakin-package.json
    ├── workspace/              SOUL/IDENTITY/AGENTS/TOOLS
    ├── skills/<name>/          (optional) runtime skill procedures
    ├── workflow-skills/*.md    (optional) workflow step instructions
    ├── lessons/*.md
    ├── assets/
    └── README.md
```

Agent package directories must be installable by themselves. Repository-level
tests validate manifest basics, ensure contributed paths exist, and enforce
context budgets on always-loaded files (see `package-contract.test.ts`);
`_`-prefixed directories are skipped.
