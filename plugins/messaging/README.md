# Messaging Plugin

Content calendar and planning-session plugin for Bakin.

## Runtime Contract

Messaging talks to agents only through `ctx.runtime.messaging`. Planning
sessions use a stable SDK-built thread ID:

```ts
brainstormThreadId('messaging', sessionId, agentId)
```

That keeps runtime conversation continuity inside the active adapter. The
plugin persists its own visible timeline for UI reloads and auditability, but
does not replay the full stored transcript into each runtime prompt.

## Session Storage

Session files live under plugin-scoped storage:

```text
messaging/sessions/<sessionId>.json
```

Each session stores:

- user and assistant messages
- streamed `activity` rows for runtime status/tool calls
- proposals and proposal status

Tool activity is normalized through the SDK before storage. Search indexes
user/assistant planning text and proposal summaries, not raw tool output.

## Tests

Relevant coverage:

- `tests/streaming.test.ts` — SSE tokens, activity streaming/persistence,
  stable runtime thread IDs
- `tests/prompt-builder.test.ts` — no stored-history prompt replay
- `tests/streaming.test.ts` — persisted activity hydration
- `tests/brainstorm-search.test.ts` — activity excluded from search body
