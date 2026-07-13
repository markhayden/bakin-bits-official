---
name: bx-search
description: 'Web search using the Brave Search CLI (`bx`). Use for ALL web search requests — including "search for", "look up", "find", "what is", "research", and any task needing current or external information. Also for: documentation lookup, troubleshooting research, news, and fetching fresh info beyond training data.'
---

# bx — Brave Search CLI

## Agent Directive

**When this skill is active, use `bx` via the bash tool for all web
searches.** Run `bx context "query"` as the default — it returns
pre-extracted, token-budgeted content ready for use (one call replaces
search + scrape + extract). Fall back to `bx answers` for synthesized
explanations or `bx web` when search operators are needed.

`bx` is installed on PATH and the API key is configured by Bakin — no setup
needed. If `bx` reports a missing or invalid key, report that honestly and
stop; the key is managed in Bakin's Settings → Integrations & Keys.

## When to Use Which Command

| Your need | Command | Why |
|-----------|---------|-----|
| Look up docs, errors, code patterns | `bx context "query" --max-tokens 4096` | Pre-extracted text, token-budgeted |
| Get a synthesized explanation | `bx answers "question" --no-stream` | AI-generated, cites sources |
| Search a specific site (site:) | `bx web "site:docs.rs axum" --count 5` | Supports search operators |
| Find discussions/forums | `bx web "query" --result-filter discussions` | Forums often have solutions |
| Latest versions/releases/news | `bx news "query" --freshness pd` | Fresh info beyond training data |

## Response Shapes

`bx context` (recommended):

```json
{ "grounding": { "generic": [
  { "url": "...", "title": "...", "snippets": ["extracted content...", "..."] }
] } }
```

`bx answers --no-stream`:

```json
{"choices": [{"message": {"content": "..."}}]}
```

`bx web`: full search results under `web.results[]` (`title`, `url`,
`description`), plus optional `news`/`videos`/`discussions` sections.

## Rules

- Always cite source URLs from results in your output.
- Never fabricate search results — if a search fails, say exactly what
  failed and complete the task with an honest failure summary.
- Do not assume `jq` is installed; read raw JSON or filter with available
  tools.
- Prefer one well-scoped `context` call over many broad searches.
