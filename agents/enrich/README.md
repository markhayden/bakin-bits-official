# Enrich

Utility vision agent backing Bakin's runtime-turn asset enrichment
(`.claude/specs/enrichment-runtime-fallback.md` in the bakin repo).

Why it exists: OpenClaw's attachment gate validates against an agent's
CONFIGURED model (per-turn overrides are ignored — bakin#584), and the
default agents' gpt-5.5 family is mis-declared text-only in the effective
catalog (bakin#583). This agent's configured model (`claude-sonnet-4-6`,
correctly declared `text+image`) passes the gate today, so enrichment can
run on the Claude subscription with zero API keys.

Point Bakin at it via the assets plugin setting `enrichmentAgent: "enrich"`
(or leave `enrichmentProvider: auto` — the ladder finds it once installed).
Retire this agent if/when the upstream bugs are fixed.
