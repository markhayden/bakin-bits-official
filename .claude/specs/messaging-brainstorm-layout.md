# Spec: Messaging Brainstorm Layout Modes

Status: implemented
Date: 2026-05-25

## Objective

Restore the active Messaging brainstorm workspace so the brainstorm thread and
Plan proposals can sit side by side by default, while giving the user an
explicit tabbed mode for narrow or focused work.

The user is the local Bakin operator reviewing an agent brainstorm session and
accepting Plan proposals. Success means the default active-session workspace no
longer collapses into a top-to-bottom split at medium widths, the Plan
proposals panel remains a right-side column in column mode, and the user can
switch to a full-width tabbed mode when that is preferable.

## Tech Stack

- React 19 client components
- TypeScript
- Tailwind utility classes through the existing SDK/UI theme
- `lucide-react` icons
- Bun test runner with Testing Library and the shared DOM preload

## Commands

```bash
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/brainstorm-consumer.test.tsx
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests
bun run typecheck
bun run lint
```

## Project Structure

```text
plugins/messaging/components/brainstorm-view.tsx
  Active brainstorm workspace layout, proposal panel, layout mode control.

plugins/messaging/tests/brainstorm-consumer.test.tsx
  Existing BrainstormView component tests; add active-session layout coverage.

plugins/messaging/README.md
  Update only if the UI behavior description needs a durable note.

.claude/specs/messaging-brainstorm-layout.md
  This spec and plan record.
```

## Code Style

Keep layout state local to `BrainstormView`, typed with narrow string unions,
and hide browser storage behind small helpers like the existing proposal panel
width helpers.

```ts
type BrainstormLayoutMode = 'columns' | 'tabs'

const BRAINSTORM_LAYOUT_STORAGE_KEY = 'messaging-brainstorm-layout'

function getStoredBrainstormLayoutMode(): BrainstormLayoutMode {
  if (typeof window === 'undefined') return 'columns'
  return window.localStorage.getItem(BRAINSTORM_LAYOUT_STORAGE_KEY) === 'tabs'
    ? 'tabs'
    : 'columns'
}
```

Use native `<button>` controls with `aria-pressed` for the two-option layout
switcher. Use lucide icons that visually distinguish the modes: `Columns2` for
side-by-side columns and `SquareStack` for tabbed/single-pane focus.

## Functional Requirements

- Default active brainstorm layout is `columns`.
- `columns` mode renders `IntegratedBrainstorm` and Plan proposals side by side
  at all app content widths; it must not depend on the current `xl:` breakpoint.
- `columns` mode keeps Plan proposals as the right-side panel.
- `columns` mode keeps the draggable proposal-panel resize handle available.
- Proposal panel width remains persisted with the existing
  `messaging-proposal-panel-width` localStorage key.
- Add a layout mode control in the active session header actions, next to the
  delete-session action.
- The layout control has two options: `Columns` and `Tabs`.
- Persist the selected layout mode in localStorage so the user preference
  survives reloads.
- `tabs` mode renders a tablist for `Brainstorm` and `Plan proposals`.
- `tabs` mode shows the proposal count in the `Plan proposals` tab label.
- `tabs` mode shows one full-width pane at a time so narrow screens avoid a
  cramped split.
- `tabs` mode does not repeat the Plan proposals section header or side-column
  chrome inside the tab panel.
- Switching modes does not reset selected proposal, messages, proposal status,
  or materialization behavior.

## Non-Goals

- No API, route, schema, or plugin storage changes.
- No migration or backward-compatibility shim for old layout state.
- No new shared design-system primitive unless the existing repo already has
  one that cleanly fits.
- No browser-specific responsive auto-switching; the user chooses the layout.

## Testing Strategy

- Add focused component tests for active-session `BrainstormView`.
- Mock an active session response with at least one Plan proposal.
- Verify default render exposes both the brainstorm pane and proposal panel in
  `columns` mode.
- Verify the resize separator is present in `columns` mode.
- Verify clicking `Tabs` switches to a tabbed UI where only the selected pane is
  visible.
- Verify the `Plan proposals` tab reveals proposals and the `Brainstorm` tab
  returns to the brainstorm pane.
- Keep existing search/session-list tests passing.

Manual verification, if a dev server is available, should include resizing the
Plan proposals panel and switching between `Columns` and `Tabs`.

## Boundaries

- Always: preserve existing proposal accept/decline/materialize behavior.
- Always: keep keyboard-accessible controls with labels and selected state.
- Always: avoid broad refactors outside the active brainstorm workspace.
- Ask first: adding dependencies, changing SDK components, changing route/API
  behavior, or changing persistent plugin data.
- Never: remove existing tests, revert unrelated user changes, or hide proposal
  actions behind a screen-size-only behavior.

## Success Criteria

- Active brainstorm sessions default to side-by-side columns.
- The screenshot regression is fixed: Plan proposals are a right-side column in
  the default layout, not a full-width section below the brainstorm.
- The user can switch to tabbed mode from the active session header.
- Tabbed mode provides full-width brainstorm and full-width proposal review
  panes.
- The proposal panel remains draggable in columns mode.
- New tests fail before the implementation and pass after it.
- `bun run typecheck` and relevant messaging tests pass.

## Open Questions

- None. The layout mode labels, icons, default behavior, and narrow-screen
  behavior have been decided.

## Implementation Plan

### Architecture Decisions

- Store layout preference as a local UI preference in `localStorage`, matching
  the existing proposal-panel width persistence pattern.
- Keep proposal list rendering in a local helper component/function inside
  `brainstorm-view.tsx` to avoid duplicating the list between columns and tabs.
- Use CSS grid for columns mode with
  `grid-cols-[minmax(0,1fr)_var(--proposal-panel-width)]` without an `xl:`
  breakpoint.
- Use local tab state only for `tabs` mode. Default active tab is `brainstorm`;
  preserve the last tab while switching layout modes during a session.

### Task List

#### Task 1: Add Layout State And Control

Description: Add typed layout mode helpers, local state, persistence, and a
compact two-option header control using `Columns2` and `SquareStack`.

Acceptance:

- Default mode is `columns`.
- Clicking `Columns` or `Tabs` updates state and localStorage.
- Active button state is accessible with `aria-pressed`.

Verify:

```bash
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/brainstorm-consumer.test.tsx
```

Files:

- `plugins/messaging/components/brainstorm-view.tsx`

#### Task 2: Refactor Active Session Layout

Description: Extract proposal panel rendering, remove the breakpoint-dependent
grid collapse, and add tabbed rendering for the same brainstorm/proposal panes.

Acceptance:

- `columns` mode renders brainstorm and proposal panel side by side.
- Proposal panel is on the right in `columns` mode.
- Resize handle is present and wired in `columns` mode.
- `tabs` mode renders one full-width pane at a time.

Verify:

```bash
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/brainstorm-consumer.test.tsx
```

Files:

- `plugins/messaging/components/brainstorm-view.tsx`

#### Task 3: Add Regression Tests

Description: Extend `brainstorm-consumer.test.tsx` with active-session layout
tests that prove the default columns layout and tabbed layout behavior.

Acceptance:

- Test confirms `Columns` is selected by default.
- Test confirms the resize separator exists in default mode.
- Test confirms `Tabs` mode switches panes with a tablist.

Verify:

```bash
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/brainstorm-consumer.test.tsx
```

Files:

- `plugins/messaging/tests/brainstorm-consumer.test.tsx`

#### Task 4: Docs And Full Verification

Description: Update README only if the UI route description needs the new
layout mode called out, then run the focused and broader checks.

Acceptance:

- Spec remains accurate after implementation.
- README is unchanged unless it would otherwise be misleading.
- Full messaging tests and typecheck pass, or failures are documented with
  exact causes.

Verify:

```bash
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests
bun run typecheck
bun run lint
```

Files:

- `.claude/specs/messaging-brainstorm-layout.md`
- `plugins/messaging/README.md` only if needed

### Commit Strategy

1. `test(messaging): cover brainstorm layout modes`
   - Add failing regression tests for default columns and tabbed behavior.
   - Rollback checkpoint: tests only, no production behavior change.

2. `feat(messaging): add brainstorm layout modes`
   - Add layout preference state/control and implement columns/tabs rendering.
   - Rollback checkpoint: feature is isolated to one component.

3. `docs(messaging): record brainstorm layout behavior`
   - Commit the spec and any README update if needed.
   - Rollback checkpoint: documentation-only.

If this lands as one local change instead of multiple commits, keep the same
logical order in staging so each checkpoint can still be reviewed separately.

### Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Columns mode can become cramped on very narrow screens. | Medium | Make `Tabs` explicit and persistent; keep column minimums stable. |
| Refactoring proposal rendering could break accept/decline behavior. | Medium | Reuse the same handlers and add active-session tests. |
| localStorage unavailable in tests or restricted browsers. | Low | Match existing try/catch persistence helpers. |
| Test mocks may not include enough SDK surface for active session rendering. | Low | Extend existing test mocks narrowly. |

### Validation Checkpoints

- Checkpoint after Task 1-2: focused layout tests pass.
- Checkpoint after Task 3: regression coverage proves both modes.
- Checkpoint after Task 4: messaging suite, typecheck, and lint have been run.

## Verification Results

2026-05-25:

- Passed:
  `bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/brainstorm-consumer.test.tsx`
- Passed:
  `bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/use-content-types.test.tsx`
- Passed:
  `bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests/calendar-local-filter.test.tsx`
- Passed: `bun run typecheck`
- Passed: `bun run lint`
- Full messaging suite command was run twice:
  `bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests`
- Full messaging suite result: 201 passed, 3 failed. The failing tests were
  unrelated `use-content-types` and `calendar-local-filter` cases that passed
  when rerun by file, indicating cross-file test pollution outside this layout
  change.
