# Enrich

Utility vision agent backing Bakin's runtime-turn asset enrichment
(`.claude/specs/enrichment-runtime-fallback.md` in the bakin repo).

Why it exists: OpenClaw's attachment gate validates against an agent's
CONFIGURED model (per-turn overrides are ignored — bakin#584), and the
default agents' gpt-5.5 family is mis-declared text-only in the effective
catalog (bakin#583). This agent pins a vision-capable `defaultModel` in
`bakin-package.json` (the one place the model is recorded) so it passes the
gate; inheriting the runtime default would silently skip every image.

Point Bakin at it via the assets plugin setting `enrichmentAgent: "enrich"`
(or leave `enrichmentProvider: auto` — the ladder finds it once installed).
Retire this agent if/when the upstream bugs are fixed.
