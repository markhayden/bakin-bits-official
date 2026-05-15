# Messaging Plugin

Messaging is Bakin's content planning plugin. It turns open-ended agent
brainstorming into content Plans, helps shape each Plan into channel-specific
content pieces, starts prep work at the right time, routes drafts through
review, and publishes approved content through Bakin channel runtimes.

## Model

The plugin owns three durable entities under plugin-scoped storage:

```text
messaging/sessions/<sessionId>.json
messaging/plans/<planId>.json
messaging/deliverables/<deliverableId>.json
```

- `BrainstormSession` stores visible chat messages, streamed runtime activity,
  Plan proposals, and the Plan ids created from the session.
- `Plan` is one topic or date focus, such as "Taco Tuesday". A Plan has a
  soft `targetDate`, a lead agent, optional campaign text, concrete channel
  configuration, and planning status.
- `Deliverable` is the channel-specific work item. It has exact `publishAt`
  and `prepStartAt` timestamps, a content type, status, draft fields, optional
  Bakin task and workflow ids, and publish/failure metadata.

Legacy top-level `messaging.json` data is archived on activate. It is not
migrated into the new model.

## UI

Messaging contributes three top-level routes:

- `/messaging/calendar` shows Deliverables on the content calendar.
- `/messaging/plans` lists Plans and opens a Plan workspace for timeline,
  task, brainstorm, and content-piece review.
- `/messaging/brainstorm` lists brainstorm sessions and embeds
  `IntegratedBrainstorm` for session chat and Plan-proposal review.

The header-level Quick Post action creates a free-floating Deliverable with
`planId: null` for one-off content.

## Lifecycle

1. Brainstorm with an agent. The agent emits fenced JSON Plan proposals with
   `title`, `targetDate`, `brief`, and optional `suggestedChannels`.
2. Accept proposals and prepare Plans from them. No production work starts at
   this step. Prepared Plans start in `needs_review`.
3. Review the Plan workspace. Confirm the angle, configure concrete channels
   with content type and publish timing, and add
   guidance in the embedded brainstorm.
4. Activate the Plan when it is ready. This is the only supported path for
   creating Plan-owned Deliverables. Activation creates one Deliverable and
   one Bakin kickoff task per configured channel. The kickoff task is scheduled
   with `availableAt = prepStartAt`, `dueAt = publishAt`, and a `source`
   pointing back to the Deliverable.
5. The task dispatcher picks up each kickoff task only after `availableAt`.
   Content types with `workflowId` use workflow-backed prep; others use bare
   Bakin tasks.
6. Drafts move to review. Approval validates required assets before status
   moves to `approved`.
7. Publishing happens through explicit workflow/channel behavior or explicit
   user action. Messaging does not register a cron job or background sweep.

Missed unapproved publish windows become `overdue`. Failed Deliverables store
`failureReason`, `failureStage`, `failedStep`, and `failedAt` so the drawer can
offer one explicit recovery action:

- `Restore approval` for workflow handoff failures where the workflow completed
  but Messaging did not record the approved state.
- `Reopen prep` for validation/workflow repair, preserving workflow-backed
  Deliverables through `workflows.reopenFromStep`.
- `Retry delivery` for channel delivery failures, with confirmation because it
  may publish or send externally.

## Content Types

`settings.contentTypes` controls prep and publishing behavior:

- `prepLeadHours` derives `prepStartAt` from `publishAt`.
- `workflowId` opts a type into workflow-backed prep.
- `requiresApproval` controls whether bare-task prep must stop in review.
- `assetRequirement` declares required or optional image/video assets.
- `defaultAgent` can route a type to a specialist.

Defaults are seeded and normalized on activate. If a configured workflow cannot
be loaded during activate, Messaging keeps the configured `workflowId`; runtime
availability is resolved by the task/workflow adapters when kickoff tasks run.
Tasks without a configured workflow include `skipWorkflowReason` so the board
records why they use bare-task prep.

## Runtime Contract

Messaging talks to agents only through `ctx.runtime.messaging`. Brainstorm
sessions use a stable SDK-built thread ID:

```ts
brainstormThreadId('messaging', sessionId, agentId)
```

That keeps runtime conversation continuity inside the active adapter. The
plugin persists its own visible timeline for UI reloads and auditability, but
does not replay the full stored transcript into each runtime prompt.

Publishing goes through `ctx.runtime.channels.deliverContent`. Asset filenames
in draft fields are resolved server-side with `ctx.assets.fileRef` immediately
before publishing.

## Routes

Routes are mounted under `/api/plugins/messaging`.

- Sessions: `GET /sessions`, `GET /sessions/:id`, `POST /sessions`,
  `PUT /sessions/:id`, `DELETE /sessions/:id`,
  `POST /sessions/:id/messages`, `PUT /sessions/:id/proposals/:proposalId`,
  `POST /sessions/:id/materialize`
- Plans: `GET /plans`, `GET /plans/:id`, `POST /plans`, `PUT /plans/:id`,
  `DELETE /plans/:id`, `DELETE /plans/:id/channels/:channelId`,
  `POST /plans/:id/activate`
- Deliverables: `GET /deliverables`, `GET /deliverables/:id`,
  `POST /deliverables`, `PUT /deliverables/:id`,
  `POST /deliverables/:id/approve`, `POST /deliverables/:id/reject`,
  `POST /deliverables/:id/approve-and-publish-now`,
  `DELETE /deliverables/:id`

`GET /search` is registered by the search subsystem for indexed brainstorm
sessions.

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
- `bakin_exec_messaging_plan_channel_delete`
- `bakin_exec_messaging_plan_activate`
- `bakin_exec_messaging_deliverable_list`
- `bakin_exec_messaging_deliverable_get`
- `bakin_exec_messaging_deliverable_create` (Quick Posts only; Plan
  Deliverables are created by Plan activation)
- `bakin_exec_messaging_deliverable_update`
- `bakin_exec_messaging_deliverable_ready_for_review`
- `bakin_exec_messaging_deliverable_approve`
- `bakin_exec_messaging_deliverable_reject`

Agent-facing activation and approval tools are blocked by default. Enable
`agentPlanActivationPolicy = allowed` or
`agentDeliverableApprovalPolicy = allowed` only for trusted agents.

## Workflows

The plugin ships three default workflow definitions:

- `messaging-blog-prep`
- `messaging-video-prep`
- `messaging-image-post-prep`

Messaging never imports the workflows plugin directly. It creates scheduled
prep tasks with
`ctx.tasks.create({ workflowId, skipWorkflowReason, availableAt, dueAt, source })`,
listens for `workflow.gate_reached`
and `workflow.complete`, and resolves gates through
`ctx.hooks.invoke('workflows.approveGate' | 'workflows.rejectGate', ...)`.
Recovery also goes through hooks: workflow-backed prep repair calls
`ctx.hooks.invoke('workflows.reopenFromStep', ...)`; Messaging never edits
workflow instance files directly.

## Tests

Run the messaging suite with the shared DOM setup:

```sh
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests
```

Relevant coverage includes storage and atomic writes, prompt building and SSE
streaming, Plan preparation and activation, scheduled kickoff task creation,
Deliverable review and publishing, workflow bridge behavior, default workflows,
content-type refresh, calendar filters, Quick Post, and the Plan/brainstorm UI.
