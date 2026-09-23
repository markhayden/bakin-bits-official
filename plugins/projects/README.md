# Projects Plugin

Markdown project specs, checklists, task links, assets, and project-scoped
brainstorming for Bakin.

## Projects collection

The index uses the kit's `ListRows variant="separated"` and interactive
`ListRow` pattern, not preview cards. Projects are text-first records; status,
item count, completion progress, and update time remain visible without opening
a project. A row opens the existing detail route. A visible three-dot menu offers
Delete project without opening the row. Confirmation names the project; deletion
removes it and its checklist items, retaining linked board tasks and asset files.
Any running project brainstorm is stopped by the existing delete endpoint.
The detail page still offers the separate opt-in to delete linked board tasks.
While deleting, confirmation and dismissal are disabled; failures stay in the
dialog for retry. Cancel returns focus to the row menu; success returns focus to
New Project after removing the row. There are no new pin or inline expansion actions.

Status chips are solid; the header's shown count is soft. Long titles and metadata
wrap on narrow screens. The shared status filter remains horizontally scrollable
on mobile; the full-screen mobile filter redesign is a separate follow-up (#759).
Search relevance ordering, URL-backed filters, creation, and live unread/working
brainstorm indicators retain their existing behavior.

Public reference: Bakin `storybook/public/lists/list-rows.stories.tsx` —
`CanonicalUsage` (separated) and `InteractiveRows`; collection composition in
`storybook/public/recipes/collection-patterns.stories.tsx` (`RowBehaviors`), and
`storybook/public/feedback/confirm-dialog.stories.tsx` (`FocusReturn`, `Busy`,
`FailedConfirmation`).

## Read-only plans

Rendered plans use `MarkdownContent` from `@makinbakin/sdk/content`, including
individual blocks annotated by Show changes. `MarkdownEditor` owns the editing
canvas and the existing empty-plan placeholder; its document-height preview
must not wrap each read-only block. That reserves 320px even for one heading.
Change markers and the rendered/diff toggle retain their existing behavior.

Public reference: Bakin `storybook/public/content/markdown-content.stories.tsx`
— `CanonicalUsage` and `ReadingAndCode`. Run `bun run test:ui:collections`
with the installed real SDK to check changed, hints-hidden, and no-history plans
at desktop and mobile widths. The plugin CI enrollment requires this fixture
alongside the index fixture. After fonts and change markers are ready, it
asserts actual gaps between rendered headings, paragraphs and lists, including
unused space after the final block. A gap over 64px fails the canonical harness
at both viewport widths. Unit tests use lightweight SDK stubs and therefore
cannot validate real markdown layout by themselves.

See [the Projects UI audit](UI-AUDIT.md) for control inventory, remaining
usability findings, and verification evidence.

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

- `tests/project-list.test.tsx` — separated row semantics, search/relevance,
  navigation/creation, loading, and progress/brainstorm indicators
- `tests/ui.fixture.tsx` / `bakin.ui-test.ts` — real index page at desktop and
  mobile widths, with long titles and all four project states. Run `bun run
  test:ui` from a standalone copy of this package with the assembled/released
  real `@makinbakin/sdk` installed, plus React/React DOM and the declared browser
  test devDependencies. The monorepo's `test-sdk` is only a unit-test double and
  cannot run this browser fixture. Inspect `test-results/bakin-ui/index.html`.
  This fixture covers the index only; detail/editor and nav-slot conformance
  enrollment remain tracked separately under T69–T70.
- `tests/routes.test.ts` — stable thread IDs, no prompt-history replay,
  activity streaming and persistence
- `tests/project-detail.test.tsx` — brainstorm hydration after reopening
- `tests/service.test.ts` — project service operations, including asset
  attach/detach/relink and missing asset resolution
