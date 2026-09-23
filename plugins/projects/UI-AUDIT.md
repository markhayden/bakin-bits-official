# Projects UI audit remediation — 2026-09-23

The original audit found oversized Markdown blocks, unsafe writes and draft exits,
missing detail accessibility coverage, narrow-layout problems and ambiguous states.
The approved implementation closes those findings through canonical SDK patterns.
No live project data or agent activity was used in verification.

| Finding | Implementation | Regression evidence |
| --- | --- | --- |
| Large Markdown gaps and lost cross-block context | One complete-document MarkdownContent with compareTo; delete the blank-line splitter | Real SDK plan geometry fixture, desktop/mobile; shared Markdown unit/story/browser tests |
| Failed saves overwrite drafts | One staged title/owner/status/body model, expected-field writes, retained failures | project-draft, project-draft-hook and project-draft-form tests |
| Concurrent human/agent edits | Untouched fields merge; overlapping fields require a choice; retries compare reviewed values | project-conflicts tests and detail browser agent-update scenario |
| Checklist failures and duplicate retries | Independent row/add state; durable receipts and stable task identities; promotion recovery | checklist-drafts and checklist-operations tests, lost-response browser scenario |
| Lost drafts on navigation | Shared keyed read/edit route component and canonical unsaved guard; partial Save All | Browser mounted-node proof, partial-success/retry and no-composer-send checks |
| Heading order, focus and keyboard traversal | Semantic h2 sections, named keyboard scroll regions, visible row actions; shared composer focus fix | Required real-SDK read/edit conformance, desktop/mobile, no suppressions |
| Crowded mobile plan toolbar | Wrapping controls and intrinsic reading height | Read/edit fixture screenshots, overflow checks and 200% text scenario |
| Empty mobile brainstorm dominates page | Canonical Collapsible with mounted content; public composer handle checks hydration | Mobile empty, disclosure, restored draft and mounted-node browser checks |
| Failed loads look missing/empty | Typed generation-checked project/history requests with explicit retry states | project-loading and history-loading tests, history error browser scenario |
| Misleading progress/lifecycle | Explicit lifecycle independent of checked count; named Checklist progress | Service/route/sync tests and displayed completed count |
| Unclear task/asset actions | Task-specific accessible names, labeled auto-growing descriptions, truthful attachment guidance and failed confirmations | Checklist form/unit coverage and real detail conformance |

## Public patterns and control choices

- `storybook/public/agents/agent-select.stories.tsx` — `SizesAndVariants`:
  owner md/outlined; brainstorm sm/filled. The approved SDK extension forwards the
  shared controls' sizes and appearance rather than overriding height/borders.
- `storybook/public/forms/form-composition.stories.tsx` — `CanonicalUsage`;
  `forms/save-bar.stories.tsx` — `CanonicalUsage`, `SaveFailureAndRetry`:
  lg/outlined title, staged owner/status/plan, one Save/Discard boundary.
- `storybook/public/primitives/input-group.stories.tsx` and
  `primitives/textarea.stories.tsx` — `CanonicalUsage`: md/outlined task entry,
  labeled sm/outlined description with bounded auto-grow (2–6 rows).
- `storybook/public/feedback/system-state.stories.tsx` — `ScopeAndRecovery`;
  `feedback/confirm-dialog.stories.tsx` — `FailedConfirmation`: durable local errors.
- `storybook/public/forms/unsaved-changes-dialog.stories.tsx` — `CanonicalUsage`:
  the SDK navigation guard owns route interception and native unload protection.
- `storybook/public/primitives/collapsible.stories.tsx` — `CanonicalUsage`;
  `conversation/panel-and-drawer.stories.tsx` — `DraftHandle`: optional mobile
  brainstorm retains its mounted content and uses the public composer handle.
- `storybook/public/content/markdown-content.stories.tsx` — `WholeDocumentComparison`,
  `ManagedDocumentContext`: full-document rendering and bounded semantic hints.
- `storybook/public/lists/list-rows.stories.tsx` — `CanonicalUsage`: separated
  task/asset rows with always-visible named actions.

Focused entrypoints: `/ui`, `/layout`, `/patterns`, `/conversation`, `/content`,
`/navigation`. No legacy barrel, local renderer/router, new token, accessibility
suppression, or design-system exception was introduced.

## Verification and coordinated rollout

The plugin's required `test:ui:collections` command now includes the plan fixture,
read and edit detail fixtures, and the real-router interaction suite. Unit tests
use stubs only for fast state checks; browser evidence uses an assembled SDK tarball
and the byte-identical canonical stylesheet. Full final counts and linked PRs are
recorded in the companion Core task evidence before handoff.

Merge the Core host/SDK prerequisite before Projects 0.11.0. CI pins the exact Core
commit used to assemble the SDK, not a moving branch. Local operation receipts need
the host's atomic single-file replacement. Roll back Projects before host/SDK and
preserve receipt metadata; see README for the older-writer limitation.

No production release, migration or installation is included.
