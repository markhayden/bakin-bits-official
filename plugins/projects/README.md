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

## Project Storage

Projects are markdown files in the plugin-scoped storage directory:

```txt
~/.bakin/plugin-data/projects/projects/<projectId>.md
```

Set `BAKIN_HOME` to move the root away from `~/.bakin`. The installed plugin
code lives separately under:

```txt
~/.bakin/plugins/projects
```

If a project returns "not found" on one machine, first confirm the markdown file
exists under the same `BAKIN_HOME` and that the browser URL project id matches
the filename without `.md`.

## Asset References

Projects store asset links as frontmatter references, not embedded asset
content:

```yaml
assets:
  - assetId: 20260401-hero-a1b2c3d4
    label: Hero mockup
```

When an asset file has been deleted or the asset plugin cannot resolve it, the
project detail UI keeps the row visible and labels it `can't find asset`.
Users can either:

- detach the broken reference, which only removes it from the project
- relink the reference to another existing asset, preserving the project context

The repair operations are available through the UI, REST API, exec tools, and
CLI metadata:

```txt
POST   /api/plugins/projects/:projectId/assets
PATCH  /api/plugins/projects/:projectId/assets/:assetId
DELETE /api/plugins/projects/:projectId/assets/:assetId

bakin projects attach-asset <projectId> <assetId>
bakin projects relink-asset <projectId> <assetId> <newAssetId>
bakin projects detach-asset <projectId> <assetId>
```

`PATCH` expects JSON with `newAssetId` and optionally `label`. If `label` is
omitted, the existing project label is preserved.

## Tests

Relevant coverage:

- `tests/routes.test.ts` — stable thread IDs, no prompt-history replay,
  activity streaming and persistence
- `tests/project-detail.test.tsx` — brainstorm hydration after reopening
- `tests/service.test.ts` — project service operations, including asset
  attach/detach/relink and missing asset resolution
