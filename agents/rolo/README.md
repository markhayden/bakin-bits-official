# Rolo — agent package

Reference agent package for Bakin's video producer.

## Layout

```
agents/rolo/
├── bakin-package.json
├── workspace/                 template files (SOUL/IDENTITY/AGENTS/TOOLS)
├── workflow-skills/
│   └── produce-video.md       generate -> mix -> save, returns assetId
├── lessons/                 lessons w/ frontmatter
│   ├── video-pacing.md        (default-enabled)
│   └── audio-craft.md         (opt-in)
└── assets/                    avatar.jpg
```

## Notes

- Skills live in an external repo (`runway-skill`), not bundled here. Set `RUNWAY_API_KEY` and `ELEVENLABS_API_KEY` in the agent's workspace `.env` per-install.
- Default-enabled lesson: `video-pacing`. Opt-in lessons: `audio-craft` (heavier audio work) and `media-rights` (music copyright, voice-cloning consent, deepfake/likeness, NSFW boundaries). Hard rights refusals also live in SOUL Boundaries (always loaded).
- Pairs naturally with the `pixel` package — Rolo dispatches to Pixel when stills are needed as video components.
- Workflow skill `produce-video` gives the video pipeline a typed output (`assetId`, `duration_s`, `has_audio`) so a dispatching agent gets a parseable result; mechanics stay in the lessons.
- **Template library is an on-demand artifact, not an always-loaded file.** AGENTS.md tells Rolo to maintain `workspace/templates.md` (read before producing, append after delivery), but it is intentionally NOT in `contributions.workspaceFiles` — created lazily and read with file tools, so it never costs per-session context. Makes the "reusable template library" responsibility real without always-loaded bloat.

## Install

```bash
bakin agents install ./agents/rolo
```
