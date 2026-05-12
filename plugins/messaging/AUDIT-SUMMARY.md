# Messaging Plugin Redesign Audit Summary

Date: 2026-05-12

This document summarizes the Messaging plugin changes on the
`feature/messaging-content-planning-redesign` branch so a follow-up audit can
review the product flow, data model, automation boundaries, and remaining
technical risks in one place.

## Scope

The redesign moved Messaging from a legacy calendar/session surface into a
content planning system with three durable entities:

- `BrainstormSession`: agent chat, streamed activity, and Plan proposals.
- `Plan`: a user-reviewed content idea with target date, owner agent, channels,
  source brainstorm, and lifecycle status.
- `Deliverable`: a channel-specific content piece with exact publish/prep
  times, draft fields, assets, task/workflow links, and review/publish status.

The current storage paths are:

```text
messaging/sessions/<sessionId>.json
messaging/plans/<planId>.json
messaging/deliverables/<deliverableId>.json
```

Legacy top-level `messaging.json` data is archived on activation instead of
being migrated into the new model.

## Product Flow

The intended content strategy flow is now:

1. Start a brainstorm session with an agent.
2. The agent proposes one or more Plans.
3. The user accepts or rejects proposals.
4. The user chooses `Complete session and prepare plans`.
5. Accepted proposals become Plans in `needs_review`.
6. No production work starts yet.
7. The user opens a Plan, reviews the angle, chooses channels, and adds
   guidance through the embedded brainstorm.
8. The user explicitly chooses `Kickoff content prep`.
9. The lead agent proposes channel-specific Deliverables for the Plan.
10. The user reviews Deliverables, accepts/rejects/edits them, then prep and
    publish automation proceeds through tasks, workflows, or sweep transitions.

This is a deliberate change from the earlier behavior where accepting or
promoting a proposal could immediately start downstream planning work.

## Major Changes

### Brainstorm Sessions

- Added durable brainstorm sessions with stable runtime thread IDs via
  `brainstormThreadId('messaging', sessionId, agentId)`.
- Stored visible messages and activity rows for UI reloads and auditability.
- Parsed agent-emitted fenced JSON into Plan proposals.
- Added proposal status controls for `proposed`, `approved`, `rejected`, and
  `revised`.
- Reworked proposal review UI copy to use content-strategy language:
  `Accept`, `Reject`, `Accepted`, `Rejected`, and `Complete session and prepare
  plans`.
- Replaced the inline "new session" header editor with the shared modal-style
  creation pattern and agent selection.
- Added session deletion, including cleanup of linked Plans when applicable.

### Plans

- Added Plan CRUD routes and agent-facing exec tools.
- Added `needs_review` as the initial status for Plans created from accepted
  proposals.
- Added explicit `Kickoff content prep` as the user-controlled boundary for
  downstream work.
- Added Plan workspace with:
  - central Plan detail/review area,
  - right-side task/progress summary,
  - embedded brainstorm for refinement,
  - channel selection as a first-class section,
  - source brainstorm link,
  - delete action.
- Added plan list grouping by target delivery date so the list is no longer a
  flat dump.
- Added a restored calendar route as a month grid for content pieces.
- Made Plan and proposal sidebars/drawers resizable where the UX expects it.

Important internal naming note: the public UI now says content prep/kickoff, but
some internal API and tool names still use `fanout`, such as
`POST /plans/:id/start-fanout` and
`bakin_exec_messaging_plan_start_fanout`. Audit whether this internal naming is
acceptable or should be migrated later.

### Deliverables

- Added Deliverable CRUD routes and exec tools.
- Added Quick Post support for free-floating Deliverables with `planId: null`.
- Added a Deliverable drawer for editing/reviewing channel-specific content.
- Added status badge support and status aggregation back to Plans.
- Added delete support for content pieces and linked board tasks.
- Added review lifecycle:
  - proposed,
  - planned,
  - in prep,
  - in review,
  - changes requested,
  - approved,
  - published,
  - overdue,
  - cancelled,
  - failed.
- Added draft fields for caption, image/video prompts, image/video filenames,
  and agent notes.
- Approval validates required image/video assets before moving a Deliverable to
  `approved`.

### Content Types And Settings

- Replaced installation-specific string unions with runtime-resolved string
  aliases for agents, channels, and content types.
- Added configurable `settings.contentTypes`.
- Added default generic content types:
  - Blog post,
  - Video,
  - X post,
  - Image post,
  - Announcement.
- Added per-content-type fields:
  - `prepLeadHours`,
  - `workflowId`,
  - `requiresApproval`,
  - `defaultAgent`,
  - `assetRequirement`.
- Added settings-event refresh support so UI content type options update without
  hardcoded channel/type assumptions.
- If a configured workflow is not loadable, Messaging clears that `workflowId`
  and falls back to bare-task prep.

### Scheduling, Sweep, And Publishing

- Added publish helpers using `ctx.runtime.channels.deliverContent`.
- Added a sweep routine for deterministic transitions:
  - planned Deliverables become prep tasks when `prepStartAt` opens,
  - approved bare-task Deliverables publish when `publishAt` opens,
  - unapproved Deliverables become `overdue` when their publish window passes.
- Added failure metadata:
  - `failureReason`,
  - `failedAt`,
  - `publishedAt`,
  - `publishedDeliveryRef`.
- Initially registered `messaging-content-sweep` directly against runtime cron.
  That created an unwanted recurring agent turn every five minutes with
  `bakin:messaging:sweep`, causing repeated MCP reads from the main agent.
- Updated Messaging to register the sweep through Schedule's
  `schedule.ensureBakinJob` hook when available, so the sweep is a
  Bakin-managed deterministic schedule instead of an LLM prompt.

Cross-repo dependency: the core Bakin repo added `schedule.ensureBakinJob` in
commit `e5cc4c76 fix(schedule): support deterministic plugin cron jobs`.
Messaging uses it in Bakin Bits commit
`25531c5 fix(messaging): register sweep as managed schedule`.

### Workflows

- Added workflow bridge behavior without importing the workflows plugin
  directly.
- Messaging creates tasks with `ctx.tasks.create({ workflowId })`.
- Messaging listens for workflow gate and completion events.
- Messaging resolves gates through:
  - `workflows.approveGate`,
  - `workflows.rejectGate`.
- Shipped default workflow definitions:
  - `messaging-blog-prep`,
  - `messaging-image-post-prep`,
  - `messaging-video-prep`.
- Workflow-backed Deliverables publish on `workflow.complete` after Messaging
  approval.

### UI Restructure

- Removed the old legacy calendar item/session surface.
- Added top-level routes:
  - `/messaging/calendar`,
  - `/messaging/plans`,
  - `/messaging/brainstorm`.
- Added React hooks for Plans, Deliverables, Plan detail, content types, and
  refresh behavior.
- Restored calendar as a month grid instead of list-only presentation.
- Added orphan/free-floating content filters for Quick Posts.
- Reworked proposal cards, status chips, and action buttons to prevent clipped
  text and inconsistent status colors.
- Aligned labels away from internal terms like "fan out" and "materialize" where
  they were exposed to users.

## API Surface

Routes are mounted under `/api/plugins/messaging`.

Sessions:

- `GET /sessions`
- `GET /sessions/:id`
- `POST /sessions`
- `PUT /sessions/:id`
- `DELETE /sessions/:id`
- `POST /sessions/:id/messages`
- `PUT /sessions/:id/proposals/:proposalId`
- `POST /sessions/:id/materialize`

Plans:

- `GET /plans`
- `GET /plans/:id`
- `POST /plans`
- `PUT /plans/:id`
- `DELETE /plans/:id`
- `POST /plans/:id/start-fanout`

Deliverables:

- `GET /deliverables`
- `GET /deliverables/:id`
- `POST /deliverables`
- `PUT /deliverables/:id`
- `DELETE /deliverables/:id`
- `POST /deliverables/:id/approve`
- `POST /deliverables/:id/reject`
- `POST /deliverables/:id/approve-and-publish-now`

Search:

- `GET /search` is registered by the search subsystem for brainstorm sessions.

## Exec Tools

Session tools:

- `bakin_exec_messaging_session_list`
- `bakin_exec_messaging_session_get`
- `bakin_exec_messaging_session_create`
- `bakin_exec_messaging_session_update`
- `bakin_exec_messaging_session_delete`
- `bakin_exec_messaging_session_message`
- `bakin_exec_messaging_proposal_update`
- `bakin_exec_messaging_session_materialize`

Plan and Deliverable tools:

- `bakin_exec_messaging_plan_list`
- `bakin_exec_messaging_plan_get`
- `bakin_exec_messaging_plan_create`
- `bakin_exec_messaging_plan_delete`
- `bakin_exec_messaging_plan_start_fanout`
- `bakin_exec_messaging_propose_deliverable`
- `bakin_exec_messaging_deliverable_list`
- `bakin_exec_messaging_deliverable_get`
- `bakin_exec_messaging_deliverable_create`
- `bakin_exec_messaging_deliverable_update`
- `bakin_exec_messaging_deliverable_ready_for_review`
- `bakin_exec_messaging_deliverable_approve`
- `bakin_exec_messaging_deliverable_reject`

## Deletion And Cleanup

- Plan deletion removes the Plan, its Deliverables, and linked board tasks when
  requested.
- Session deletion can remove linked Plans and their downstream items.
- Linked task cleanup is bounded so user-facing deletes do not hang on slow task
  service calls.
- Content item deletes were restored after the UI route transition.

Audit point: verify whether bounded cleanup should surface partial cleanup
warnings more explicitly to users or administrative logs.

## Current Status Model

Plan statuses:

- `needs_review`
- `planning`
- `fanning_out`
- `in_prep`
- `in_review`
- `scheduled`
- `overdue`
- `partially_published`
- `done`
- `cancelled`
- `failed`

Deliverable statuses:

- `proposed`
- `planned`
- `in_prep`
- `in_review`
- `changes_requested`
- `approved`
- `published`
- `overdue`
- `cancelled`
- `failed`

Status aggregation preserves `needs_review` for Plans with no Deliverables and
no kickoff. Once kickoff starts and no Deliverables exist yet, the Plan derives
`fanning_out`.

## Tests Added Or Updated

Coverage was added or updated around:

- activation and sweep cron registration,
- storage and atomic writes,
- legacy archive behavior,
- prompt building and streaming,
- proposal parsing and materialization,
- Plan CRUD and status aggregation,
- Deliverable CRUD, review, delete, and publish behavior,
- workflow bridge behavior,
- default workflow registration,
- content type settings normalization and refresh,
- calendar filters and orphan/Quick Post behavior,
- Plan UI and brainstorm UI interactions,
- Deliverable drawer and Quick Post components.

Common verification command:

```sh
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests
```

Focused verification used during the latest changes:

```sh
bun test --isolate --preload ./test/setup-dom.ts \
  plugins/messaging/tests/activate.test.ts \
  plugins/messaging/tests/materialize.test.ts \
  plugins/messaging/tests/plan-status.test.ts \
  plugins/messaging/tests/status-machine.test.ts \
  plugins/messaging/tests/plans-routes.test.ts \
  plugins/messaging/tests/plan-ui.test.tsx \
  plugins/messaging/tests/calendar-local-filter.test.tsx \
  plugins/messaging/tests/brainstorm-consumer.test.tsx
```

## Audit Checklist

- Confirm `needs_review` Plans cannot create tasks or Deliverables until the
  user explicitly starts content prep.
- Confirm accepting/rejecting brainstorm proposals only changes proposal state
  and does not create downstream work until session completion.
- Confirm `Complete session and prepare plans` creates Plans but no task work.
- Confirm `Kickoff content prep` requires enough user context, especially
  channel selection, before creating the planning task.
- Confirm public copy avoids engineering terms such as `fan out` and
  `materialize`.
- Decide whether internal API/tool names containing `fanout` should be renamed
  or left as implementation details.
- Confirm the sweep cron is Bakin-managed after activation and is not an
  `agentTurn` payload.
- Confirm a five-minute deterministic sweep cadence is still appropriate now
  that it no longer wakes an LLM.
- Confirm Schedule/Messaging activation order cannot leave the sweep in legacy
  runtime-agent mode.
- Confirm plan/session/delete operations surface partial cleanup failures
  clearly enough.
- Confirm channel selection should remain chips only or evolve into a richer
  available-channel picker.
- Confirm Brainstorm and Plans are distinct enough in the information
  architecture for content strategists.
- Confirm Quick Posts and planned Deliverables share enough UI affordances
  without confusing one-off content with campaign/Plan work.
- Confirm workflow-backed and bare-task-backed Deliverables have equivalent
  review and publish guardrails.

## Key Files For Review

- `plugins/messaging/types.ts`
- `plugins/messaging/index.ts`
- `plugins/messaging/lib/content-storage.ts`
- `plugins/messaging/lib/materialize.ts`
- `plugins/messaging/lib/plan-status.ts`
- `plugins/messaging/lib/sweep.ts`
- `plugins/messaging/lib/publish.ts`
- `plugins/messaging/lib/workflow-bridge.ts`
- `plugins/messaging/lib/deliverable-lifecycle.ts`
- `plugins/messaging/components/brainstorm-view.tsx`
- `plugins/messaging/components/plan-list.tsx`
- `plugins/messaging/components/plan-workspace.tsx`
- `plugins/messaging/components/content-calendar.tsx`
- `plugins/messaging/components/deliverable-drawer.tsx`
- `plugins/messaging/components/quick-post-button.tsx`
- `plugins/messaging/defaults/workflows/*.yaml`
- `plugins/messaging/tests/*`

## Commit Map

Core domain and storage:

- `b05752b` added content planning domain types.
- `6a36c75` added atomic JSON writes.
- `3b9d6c1` added entity storage modules.
- `a9d31cd` added Plan status aggregation.
- `a8fff6a` archived legacy calendar storage.
- `a3282f7` normalized content type settings.

Brainstorm to Plan:

- `4b693f0` emitted Plan proposals from brainstorms.
- `229be40` materialized accepted proposals into Plans.
- `e0bcd7f` added Plan CRUD routes.
- `e53bbca` added initial Plan kickoff/fan-out task support.
- `b683ed3` added deliverable proposal tools from kickoff work.

Deliverables, publishing, and workflows:

- `f7e5790` added Deliverable CRUD routes.
- `82e1d3a` added publish helpers.
- `cffbd57` registered the initial content sweep cron.
- `37bb59e` started prep from sweep.
- `27c419b` added sweep publish and overdue transitions.
- `033cf58` added workflow bridge behavior.
- `3a66994` shipped default prep workflows.
- `c332e53` added Deliverable review lifecycle.

Client/UI restructuring:

- `7355b7b` added content planning client routes.
- `27abc4f` added Deliverable drawer and Quick Posts.
- `60b161b` refreshed content types from settings events.
- `018b53b` surfaced orphan calendar filters.
- `218aa0e` removed legacy calendar item/session surface.
- `1500b92` documented the redesign in the Messaging README.

Post-test product fixes:

- `4ae1d6b` improved brainstorm proposal review.
- `a7d49df` aligned workflow language for content strategists.
- `000a28a` polished proposal review controls.
- `e1da231` made proposal sidebar width resizable.
- `0665979` prevented Plan delete hangs.
- `4e542d1` bounded delete cleanup latency.
- `029c1eb` restored content item deletes.
- `457a5f7` moved brainstorm session creation into a modal.
- `bdef7b6` required Plan review before content prep and restored calendar/list
  prioritization behavior.
- `25531c5` registered the Messaging sweep as a managed Schedule job.
