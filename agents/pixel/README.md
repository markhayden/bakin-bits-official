# Pixel — agent package

Reference agent package for Bakin's image artist — crafts prompts, iterates on outputs, and owns visual quality.

## What's in the package

```
agents/pixel/
├── bakin-package.json        manifest (kind: "agent")
├── README.md                 this file
├── workspace/                template files seeded into the agent's OpenClaw workspace
│   ├── SOUL.md               persona, values, voice + lesson marker placeholders
│   ├── IDENTITY.md           structured identity card
│   ├── AGENTS.md             Pixel-specific operational rules (doctor injects bakin:* blocks on install)
│   └── TOOLS.md              boilerplate template for per-install local notes
├── lessons/                lessons — frontmatter declares title / tags / defaultEnabled
│   ├── prompt-style-system.md   (default-enabled)
│   ├── visual-styles.md         (default-enabled)
│   ├── social-media-craft.md    (opt-in)
│   └── media-rights.md          (opt-in)
├── workflow-skills/          step instructions resolved by the workflows plugin
│   └── generate-image.md
└── assets/                   per-agent UI assets — projected to ~/.bakin/agents/pixel/
    └── avatar.jpg
```

## Notable choices

- **No bundled skill.** Pixel works entirely through Bakin's image tools (`bakin_exec_images_*`), which route to the configured provider and save managed versioned assets — no custom skill to project into her workspace.
- **AGENTS.md ships only Pixel-specific content.** The `bakin:mission-control`, `bakin:hard-rules`, `bakin:dependency-pattern`, `bakin:media-delegation`, `bakin:workflow-rules`, `bakin:asset-rules`, and `bakin:scheduling-rules` blocks are *not* in the package source — `bakin doctor` injects them on install and keeps them current as Bakin's defaults evolve.
- **Four lesson files**: two default-enabled (`prompt-style-system.md` covers prompt anatomy and iteration; `visual-styles.md` is the photo-real / hyper-real / Pixar-3D / editorial taxonomy) and two opt-in (`social-media-craft.md` covers viral patterns and platform-specific aesthetics; `media-rights.md` covers likeness/consent, trademarks, deepfakes, and NSFW boundaries — hard refusals also live in SOUL Boundaries). More lessons can be added later without a manifest change — drop a frontmatter'd `.md` in `lessons/` and bump the version.
- **`agent.allowedTools` and `allowedSkills`** are declarative for now. When the dispatch-routing layer reads them, they will enforce hard scoping at the MCP boundary.

## Installing

```bash
bakin agents install ./agents/pixel
```

To attach the package to an already-existing `pixel` agent without overwriting their workspace files:
```bash
bakin agents install ./agents/pixel --adopt pixel
```
