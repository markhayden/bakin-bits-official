# Projects Plugin

Markdown project specs, checklists, task links, assets, and project-scoped
brainstorming for Bakin.

## Runtime Contract

Project brainstorm talks to agents only through `ctx.runtime.messaging`. The
project detail UI uses a stable SDK-built thread ID:

```ts
brainstormThreadId('projects', projectId, agentId)
```

The same `projectId + agentId` pair reuses the same runtime conversation
through the active adapter. Stored brainstorm messages are for UI hydration and
traceability, not prompt-history replay.

## Brainstorm Storage

Brainstorm messages are stored in the project markdown frontmatter alongside
the project spec. The timeline can contain:

- user messages
- assistant messages
- normalized `activity` rows for runtime status/tool calls

Activity rows are streamed to the UI as they happen and persisted so reopening a
project still shows what the agent did behind the scenes.

## Tests

Relevant coverage:

- `tests/routes.test.ts` — stable thread IDs, no prompt-history replay,
  activity streaming and persistence
- `tests/project-detail.test.tsx` — brainstorm hydration after reopening
