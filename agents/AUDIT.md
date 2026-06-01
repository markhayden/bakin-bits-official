# Agent Package Audit

_Audit of the four official agent packages (`patch`, `pixel`, `rolo`, `jessica`) — bloat,
inconsistency, and gaps. Normalization applied on branch `agents/audit-normalize`._

## Framing

Each agent ships four **workspace files** — `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md` —
that are injected into the agent's context **every session**. `lessons/*.md` load conditionally
(`defaultEnabled`), and `skills/` / `workflow-skills/` load on demand. So the optimization rule
is: **keep the always-loaded workspace files tight; push depth into lessons and mechanics into
skills.**

## Target contract (applied)

| File | Role | Budget |
|---|---|---|
| `SOUL.md` | Persona only — `# Soul`, `Core Values` / `Voice` / `Boundaries`, lesson markers | ≤ ~150 w |
| `IDENTITY.md` | The card — Name, Role, Emoji, Vibe, Primary Function | ~6 lines |
| `AGENTS.md` | Agent-specific *policy* only — no SOUL restatement, no tool mechanics/curl/paths | ≤ ~200 w |
| `TOOLS.md` | Per-install local-notes template | — |
| `lessons/*.md` | Depth / elaboration | — |
| `skills/`, `workflow-skills/` | Mechanics (curl, ffmpeg, tool call patterns) | — |

No hardcoded model ids in any file — agents inherit the Bakin/runtime default.

## Findings

### A. Always-loaded context bloat
1. **Patch** stated the same rules 3× (SOUL Boundaries ↔ AGENTS "Patch-Specific Rules" ↔
   `dev-discipline` lesson). The AGENTS copy was redundant; removed.
2. **Pixel** `AGENTS.md` (572 w) duplicated the curl walkthrough already in
   `workflow-skills/generate-image.md` (503 w). Trimmed AGENTS to policy.
3. **Rolo** `AGENTS.md` (395 w) embedded curl commands, API endpoints, and an ffmpeg filter
   graph. Mechanics moved to the `audio-craft` lesson; AGENTS holds policy.
4. **Jessica** `SOUL.md` (398 w) and `AGENTS.md` restated mission + workflow twice. Collapsed;
   SOUL trimmed to the ~150 w band.
5. **Shared cross-agent rules were hand-copied and drifted** ("report to whoever invoked you",
   "never post to Discord", `TASK COMPLETE:` format) — present in pixel/rolo/jessica, absent in
   patch. Normalized: report-destination consistent across all four; deliverable format kept
   per-agent (patch reports a PR/branch, not an `assetId`).

### B. Inconsistencies (mechanical)
6. SOUL headings: `# Soul` vs `# SOUL.md` → standardized to `# Soul`.
7. IDENTITY fields: patch had `Default Model`, jessica had `Default Mode` → fixed field set.
8. `allowedTools`: patch omitted it, others `[]` → explicit `[]` on all four.
9. SOUL structure: jessica used a different, longer scheme → aligned to the common shape.

### C. Correctness / contradictions / stale docs
10. **`/opt/homebrew/lib/node_modules/openclaw/.../generate_image.py` in `pixel/AGENTS.md`** —
    the only machine-path/install-location reference in the whole repo, and invalid on a default
    (binary) Bakin install. Removed with the native-nano-banana block (see 14).
11. `jessica/README.md` claimed `bakin_exec_search_*` tools while the manifest had empty
    `allowedTools`/`allowedSkills`. Reconciled.
12. `agents/README.md` layout showed `_template/` (absent) and `workflows/*.yaml` (no agent ships
    one). Corrected.
13. `pixel/README.md` carried stale refactor meta-narrative and an aspirational
    `bakin-agent-pixel` repo / cross-repo issue link. Trimmed.
14. **Native nano-banana fallback removed entirely.** Confirmed in `../bakin`: all image ops go
    through `bakin_exec_images_*`; no native `generate_image.py` calls exist. Multi-image
    composition, if needed, is a bakin-side change — not pixel shelling out.
15. **Rolo "Background Music" used the wrong endpoint.** It POSTed to `/v1/sound-generation`
    (sound effects). The correct music endpoint is `POST https://api.elevenlabs.io/v1/music`
    with body `{"prompt", "music_length_ms", "model_id":"music_v1"}` (verified against ElevenLabs
    docs). Fixed in the `audio-craft` lesson. Note: Bakin does **not** call ElevenLabs itself —
    audio is delegated to the agent's runtime, so rolo's own calls are the implementation.

### D. Gaps addressed
16. No context budget on always-loaded files → soft word-count guard added to the contract test.
17. No CI guard for machine-path / hardcoded-model classes → added to the contract test.
18. Patch lacked a report-destination rule → added (tailored, dev-appropriate).
19. Hardcoded models (patch `defaultModel` + IDENTITY + README; rolo ElevenLabs `model_id`) →
    removed; contract test now asserts no agent sets `agent.defaultModel`.

## Verified against `../bakin`
- `bakin_exec_images_{generate,edit,import,export}` exist and route through the versioned asset
  service; no native nano-banana usage anywhere.
- Bakin exposes no audio/TTS exec tool; audio generation is the agent's responsibility.
