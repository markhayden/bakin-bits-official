# Projects UI — pattern map (projects revamp, 2026-10-25)

The revamp (spec: Bakin `.claude/specs/projects-revamp.md` D7–D18, D27–D29) rebuilt
Projects around one idea: the project conversation is the primary surface,
and everything else is a tab beside it. This file maps every surface to the
public Storybook contract it composes. Earlier audit findings (2026-09-23 —
plan rendering, staged saves, retry receipts, unsaved-change exits, history
states) still hold where noted.

| Surface | Public pattern (Bakin `storybook/public/…`) | Notes |
| --- | --- | --- |
| Start screen | `conversation/timeline` — `ContainedAndEmptyStates` (empty state with suggestions); `conversation/composer` — `CanonicalUsage`; `agents/agent-select` — `SizesAndVariants` | No modal: chips pre-fill the composer, nothing is created until send; the lead picker is the composer's leading slot. |
| Page frame | `recipes/list-detail-pages` — `ContainedDetailWorkspace` | `Page scroll="contained"` owns the gutters; the tab panel or the conversation owns the one scroller. |
| Header | `pages/page` + `PageHeader`; `feedback/confirm-dialog` — `CanonicalUsage`, `FailedConfirmation`; `lists/list-rows` — `CanonicalUsage` (`StatusBadge`) | One next-step button; Start is the hand-off confirm (step count + "Review steps first" link to the Steps tab); Mark complete names unfinished steps; ⋯ overflow for Pause/Resume check-ins, Archive, Details, Delete; an outline `StatusBadge` "Paused" beside the status. |
| Rename / Details | Chat's rename-dialog recipe (`Dialog` + `DialogFooter` Cancel/Save); `layout/key-value` | No inline title pattern exists, so rename uses the dialog the chat plugin uses; the footer is the standard Cancel/Save pair. |
| Tabs | `navigation/tabs` — `UnderlineNavigation` | Controlled, URL state (`?tab`), consumer-owned `project-panel-*` panels; the Plan tab carries a `StatusMarker` when an agent revision is unseen. |
| Conversation | `conversation/panel-and-drawer` — `DocumentDividerPanel`; `conversation/turns` — `QuestionCards` | `ConversationPanel fitParent chrome="top-divider"`; question cards answer through the panel's send. |
| Docked conversation | `pages/collapsible-aside` — `ConversationDock` | Public `PageAside width="conversation" side="end"` rail (approved extension); collapsed strip shows the lead's avatar + working/unread marker; exactly one mounted composer. |
| Plan | `content/markdown-content` — `WholeDocumentComparison`, `ManagedDocumentContext`; `forms/save-bar` — `CanonicalUsage`, `SaveFailureAndRetry`; `forms/unsaved-changes-dialog` | Edit in place on the tab (`?edit=1`), body-only draft with Use latest / Keep mine; History view (`?view=changes`) with restore. |
| Steps | `lists/list-rows` — `CanonicalUsage`; `primitives/input-group`, `primitives/textarea`, `primitives/progress` | Board state in words; Send to board / Open task actions whose names start with their visible text; linked checkboxes read-only. |
| Files | `lists/list-rows`; `patterns/asset-picker`; `feedback/system-state` — `ScopeAndRecovery` | Produced (derived) and Attached groups; composer paperclip uploads and attaches. |
| List | `lists/list-rows` — `CanonicalUsage`, `InteractiveRows`; `recipes/collection-patterns` — `RowBehaviors` | One resume signal per row (steward signals: Needs approval, Stuck, Check-ins paused for today) + the "Paused" badge; archived out of "All". |
| Sign-off decision | Bakin's task `ApprovalPanel` (host, `plugin-gate` renderer) | Projects renders nothing of its own: `ctx.approvals` puts the request on the check-in (or deliverable) task's "Needs approval" card. |

Focused entrypoints only: `/ui`, `/layout`, `/patterns`, `/conversation`,
`/content`, `/navigation`, `/hooks`, `/utils`. No legacy barrel, local
router, new token, accessibility suppression or design-system exception.

## Kit fixes the real-SDK run surfaced (Bakin)

- `ConversationEmptyState` takes `headingLevel` (an `h3` directly under a
  page `h1` broke heading order).
- The composer's native file input is `aria-hidden` (enabling attachments
  otherwise failed the keyboard-order check).

## Verification

Real SDK (`BAKIN_SDK_PACKAGE_DIR=… bun run ui:conformance` at the repo root):
the list fixture, the plan-spacing fixture, every detail surface
(conversation, plan, steps, files) and the start screen at desktop and
mobile, plus `tests/detail.browser-test.ts` — 6 interaction scenarios. Unit
tests (`bun run test`) cover the server, the lead posture and every
component against the `test-sdk` stubs.
