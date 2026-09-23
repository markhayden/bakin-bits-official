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

## Editing a project

Title, owner, lifecycle status and plan form one staged draft. Save changes writes
only edited fields with their expected server values; Discard returns all four
fields to the latest server version. Agent updates merge into untouched fields.
Overlapping edits stay visible until you choose Use latest or Keep mine. Keep mine
is conditional on the value you reviewed, so another update can conflict again.

Checklist descriptions and new tasks are independent drafts. Failed actions keep
the text and show local errors; other rows stay usable. Add and promotion retries
use durable operation identities to avoid duplicates after a lost response.
Deleting an item never lets an old retry recreate it or modify a reused display ID.
Completed tasks are visible by default; Hide completed is saved per project.
Checklist progress and project lifecycle are independent, including Completed
projects with unchecked tasks.

Leaving offers Save all and leave, Discard, or Stay. Save All validates every draft,
saves project fields, descriptions in item order, then the new task. Partial
successes remain saved; retry only submits unfinished work. It never sends the
brainstorm composer. Read and edit routes keep the same project component mounted.
On mobile an empty brainstorm starts collapsed; existing conversation, active work
or a restored composer draft keeps it open. Explicit disclosure changes retain the
mounted conversation and draft. Desktop keeps the brainstorm expanded.

## Read-only plans and history

`MarkdownContent` receives the complete current plan and optional complete
`compareTo` source. Managed sections, reference links, lists, tables and code retain
full-document context. Changed blocks and deletion markers are accessible; precise
line review remains in Diff. An exceeded comparison budget says unavailable rather
than claiming no changes. History loading, missing history and failed/corrupt history
are distinct. Restore confirms the exact snapshot reviewed and retains errors for retry.

Public references: Bakin `content/markdown-content` — `Comparison` and
`ManagedDocumentContext`; `forms/form-composition`, `forms/save-bar`,
`forms/unsaved-changes-dialog`; `feedback/system-state`, `feedback/confirm-dialog`;
`agents/agent-select`, `primitives/collapsible` and `conversation/panel-and-drawer`.
The exact exports and evidence are listed in [UI-AUDIT.md](UI-AUDIT.md).

With the installed real SDK, `bun run test:ui` checks the index and
`bun run test:ui:collections` checks plan spacing, read/edit detail accessibility,
route-state retention, overlaps, retry receipts, partial saves and mobile composer
restoration. These are required in official-plugin CI; unit stubs alone do not
certify layout or routing. Reports live under `test-results/bakin-ui-*`.

## Host prerequisite and mutation storage

Projects 0.11.0 requires the companion Bakin host's atomic scoped-storage replacement
and matching SDK/CSS build. Install the host prerequisite before upgrading Projects.
An SDK-only upgrade does not provide storage atomicity.

Optional private `operations` frontmatter records durable add results and promotion
reservations for the project's lifetime. Checklist `instanceId` separates stable
identity from reusable display IDs. Promotion reserves a board-task ID and source
provenance before creation; retries verify that task before linking. An uncertain
create failure is reported honestly and resumed against the same ID. Records are
omitted from browser detail responses and removed with the project.

For rollback, roll Projects back before the companion host/SDK. Preserve project
files and their operation metadata. Older plugin versions do not preserve those
receipts when writing, so avoid resuming uncertain operations through older code.
No release, installation, or production migration is performed by this change.

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

Brainstorm messages use the project's `.brainstorm.json` sidecar in the same
plugin-scoped directory as the Markdown project. It stores the conversation kit's
user, assistant, tool, error and aborted rows, bounded to 300 rows. A separate
`.brainstorm-seen.json` records attention state; `.history.json` holds up to 20 prior
plan bodies. These files do not replace the composer's existing draft persistence.

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
