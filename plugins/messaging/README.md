# Messaging Plugin

Messaging is Bakin's content planning plugin. It turns open-ended agent
brainstorming into content Plans, fans each Plan out into per-channel
Deliverables, starts prep work at the right time, routes drafts through review,
and publishes approved content through Bakin channel runtimes.

## Model

The plugin owns three durable entities under plugin-scoped storage:

```text
messaging/sessions/<sessionId>.json
messaging/plans/<planId>.json
messaging/deliverables/<deliverableId>.json
```

- `BrainstormSession` stores visible chat messages, streamed runtime activity,
  Plan proposals, and the Plan ids materialized from the session.
- `Plan` is one topic or date focus, such as "Taco Tuesday". A Plan has a
  soft `targetDate`, a lead agent, optional campaign text, and fan-out status.
- `Deliverable` is the channel-specific work item. It has exact `publishAt`
  and `prepStartAt` timestamps, a content type, status, draft fields, optional
  Bakin task and workflow ids, and publish/failure metadata.

Legacy top-level `messaging.json` data is archived on activate. It is not
migrated into the new model.

## UI

Messaging contributes three top-level routes:

- `/messaging/calendar` shows Deliverables on the content calendar.
- `/messaging/plans` lists Plans and opens a Plan workspace for fan-out and
  Deliverable review.
- `/messaging/brainstorm` lists brainstorm sessions and embeds
  `IntegratedBrainstorm` for session chat and Plan-proposal review.

The header-level Quick Post action creates a free-floating Deliverable with
`planId: null` for one-off content.

## Lifecycle

1. Brainstorm with an agent. The agent emits fenced JSON Plan proposals with
   `title`, `targetDate`, `brief`, and optional `suggestedChannels`.
2. Approve proposals and materialize them into Plans.
3. Start Plan fan-out. A Bakin task asks the lead agent to call
   `bakin_exec_messaging_propose_deliverable` once per intended channel.
4. Approve, edit, or reject proposed Deliverables in the Plan workspace.
5. The sweep cron runs `bakin:messaging:sweep`. Planned Deliverables whose prep
   window has opened become prep tasks. Content types with `workflowId` use
   workflow-backed prep; others use bare Bakin tasks.
6. Drafts move to review. Approval validates required assets before status
   moves to `approved`.
7. Approved bare-task Deliverables publish on the sweep when `publishAt` is due.
   Workflow-backed Deliverables publish on `workflow.complete` after messaging
   has approved the gate.

Missed unapproved publish windows become `overdue`. Failed publishes store
`failureReason` and `failedAt`.

## Content Types

`settings.contentTypes` controls prep and publishing behavior:

- `prepLeadHours` derives `prepStartAt` from `publishAt`.
- `workflowId` opts a type into workflow-backed prep.
- `requiresApproval` controls whether bare-task prep must stop in review.
- `assetRequirement` declares required or optional image/video assets.
- `defaultAgent` can route a type to a specialist.

Defaults are seeded and normalized on activate. If a configured workflow cannot
be loaded, Messaging clears that `workflowId` and falls back to bare-task prep.

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
  `DELETE /plans/:id`, `POST /plans/:id/start-fanout`
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
- `bakin_exec_messaging_plan_start_fanout`
- `bakin_exec_messaging_propose_deliverable`
- `bakin_exec_messaging_deliverable_list`
- `bakin_exec_messaging_deliverable_get`
- `bakin_exec_messaging_deliverable_create`
- `bakin_exec_messaging_deliverable_update`
- `bakin_exec_messaging_deliverable_ready_for_review`
- `bakin_exec_messaging_deliverable_approve`
- `bakin_exec_messaging_deliverable_reject`

## Workflows

The plugin ships three default workflow definitions:

- `messaging-blog-prep`
- `messaging-video-prep`
- `messaging-image-post-prep`

Messaging never imports the workflows plugin directly. It creates prep tasks
with `ctx.tasks.create({ workflowId })`, listens for `workflow.gate_reached`
and `workflow.complete`, and resolves gates through
`ctx.hooks.invoke('workflows.approveGate' | 'workflows.rejectGate', ...)`.

## Tests

Run the messaging suite with the shared DOM setup:

```sh
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests
```

Relevant coverage includes storage and atomic writes, prompt building and SSE
streaming, Plan materialization, fan-out, Deliverable review and publishing,
workflow bridge behavior, default workflows, content-type refresh, calendar
filters, Quick Post, and the Plan/brainstorm UI.
