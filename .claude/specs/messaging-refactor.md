# Spec: Messaging Plan Refactor And Scheduled Task Foundation

## Objective

Refactor Messaging so content planning is explicit, inspectable, and paced by the task system instead of plugin-owned background sweeps.

The current Messaging refactor introduced a plugin-owned cron sweep that wakes independently and can spam runtime/MCP endpoints. This change removes that mechanism entirely. Plans become strategic containers, plan channels become the activation contract, deliverables become operational units, and board tasks become the source of truth for work that agents can pick up.

Success means:

- Messaging registers no cron jobs and no sweep hook.
- Schedule remains scoped to cron/recurring jobs.
- Core tasks support `availableAt`, `dueAt`, and `source`.
- Dispatch does not pick up future scheduled tasks.
- Plans cannot activate until concrete channels are defined.
- Activation creates one deliverable and one scheduled kickoff task per channel.
- Messaging UI follows Projects layout and shared UI patterns.

## Repositories

- Core/SDK/framework work: `/Users/roscoe/go/src/github.com/markhayden/bakin`
- Messaging plugin work: `/Users/roscoe/go/src/github.com/markhayden/bakin-bits-official`

## Commands

Core:

```bash
bun test --isolate
bun run typecheck
bun run lint
bun run docs:generate
bun run docs:check
```

Messaging:

```bash
bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests
bun run typecheck
bun run lint
```

## Core Task Contract

Tasks gain scheduling and provenance fields:

```ts
interface Task {
  availableAt?: string
  dueAt?: string
  source?: {
    pluginId?: string
    entityType?: string
    entityId?: string
    purpose?: string
  }
}
```

`availableAt` is the earliest dispatch pickup time. It is not a deadline and not a new board column.

`dueAt` is a user-facing expectation or deadline.

`source` records plugin/domain provenance so Messaging can link tasks back to deliverables and later repair missing links.

Dispatch eligibility:

```ts
isDispatchEligible(task, now) =
  task.column === 'todo'
  && (!task.availableAt || Date.parse(task.availableAt) <= now)
  && dependenciesAreComplete(task)
  && agentExists(task.agent)
```

## Scheduled Task UI

Future scheduled tasks remain in their normal column.

- In a column, eligible/normal tasks render first.
- Future scheduled tasks render at the bottom under a scheduled divider.
- The task board exposes a `Show scheduled` filter.
- A scheduled task automatically joins the normal group once `availableAt <= now`; no mutation is required.

## Workflow Contract

Workflows should gain a built-in `createTask` node. This is not Messaging-specific. It creates a real board task and accepts the normal task scheduling fields:

```yaml
- id: create-publish-task
  type: createTask
  title: Publish launch message
  description: Publish the approved message to the selected channel.
  agent: "$assigned"
  workflowId: messaging-publish-message
  availableAt: "{{inputs.publishAt}}"
  dueAt: "{{inputs.publishAt}}"
  parentId: "{{task.id}}"
  idempotencyKey: "messaging:deliverable:{{inputs.deliverableId}}:publish"
  source:
    pluginId: messaging
    entityType: deliverable
    entityId: "{{inputs.deliverableId}}"
    purpose: publish
```

Most Messaging workflow steps should not be individually scheduled. The initial kickoff task paces intake; workflow steps then run as soon as approvals and dependencies allow. Final publish behavior is handled by channel skills where possible, with a scheduled publish task as fallback when native channel scheduling is unavailable.

## Messaging Plan Contract

`suggestedChannels` is removed. A plan uses concrete channels:

```ts
interface Plan {
  channels: PlanChannel[]
}

interface PlanChannel {
  id: string
  channel: string
  contentType: string
  publishAt: string
  prepStartAt?: string
  workflowId?: string
  agent?: string
}
```

Before activation, `channels` can be agent-proposed and user-edited. At activation, it becomes the validated operational contract.

Activation requires:

- at least one channel
- every channel has `channel`, `contentType`, and `publishAt`
- content type resolves to Messaging settings
- prep start can be derived or explicitly set

Activation creates one deliverable and one scheduled kickoff task per channel.

## Messaging Deliverable Contract

Deliverables remain the domain objects shown in Messaging calendar and plan detail views.

For each channel row:

```ts
Deliverable {
  planId: plan.id,
  planChannelId: planChannel.id,
  channel: planChannel.channel,
  contentType: planChannel.contentType,
  publishAt: planChannel.publishAt,
  prepStartAt: planChannel.prepStartAt ?? derivedLeadTime,
  taskId: kickoffTask.id,
  status: "planned"
}
```

Kickoff task:

```ts
Task {
  title: `Prep ${channel}: ${plan.title}`,
  column: "todo",
  availableAt: deliverable.prepStartAt,
  dueAt: deliverable.publishAt,
  workflowId: planChannel.workflowId ?? contentType.workflowId,
  agent: planChannel.agent ?? plan.agent,
  source: {
    pluginId: "messaging",
    entityType: "deliverable",
    entityId: deliverable.id,
    purpose: "kickoff"
  }
}
```

## Removed Messaging Sweep

Messaging must not:

- register `messaging.sweep.run`
- create `messaging-content-sweep`
- depend on `schedule`
- request `runtime.cron`
- auto-publish approved deliverables from a background loop

Publishing happens through explicit workflow/channel skills or explicit user actions.

## Edit And Delete Behavior

Active plans remain editable. Channel edits compute an impact diff:

- added channel: create deliverable and scheduled kickoff task
- changed channel not started: update deliverable and scheduled task
- removed channel not started: delete task and cancel/delete deliverable
- removed channel in flight/review: require confirmation, then cancel deliverable and cancel/archive task with history preserved
- published/done: preserve history and never silently erase external effects

Delete behavior:

- brainstorm delete hard-deletes brainstorm/session data only
- plan delete requires impact preview and confirmation when linked work exists
- deliverable/channel delete uses the same impact rules as channel removal
- task deletion must go through normal task APIs so workflow cancellation hooks fire
- external scheduled/published content is warned about or cancelled only when a channel integration supports it

Implemented first pass:

- bulk channel replacement is blocked after activation
- active channel removal uses `DELETE /plans/:id/channels/:channelId`
- that route/tool deletes the configured channel, associated Deliverables, and
  linked board tasks through the task API

## Messaging UI Contract

Messaging plan UI should closely follow Projects.

Use the Projects detail layout as the baseline:

- top bar with back, status, agent/owner, edit/save/cancel, delete
- main scrollable details column
- pinned `IntegratedBrainstorm`
- right sidebar for progress, metadata, links, activation/manage actions

Use the Projects list conventions:

- `PluginHeader`
- search/filter row
- compact cards/rows
- SDK empty/loading states

Messaging-specific UI:

- concrete channel editor instead of suggested channel chips
- activation validation and clear feedback
- impact-preview dialogs for destructive edits
- calendar remains the domain view for deliverables and publish dates

## Verification Completed

- `bun run typecheck`
- `bun run lint`
- `bun test --isolate --preload ./test/setup-dom.ts plugins/messaging/tests`
- stale sweep scan for `bakin:messaging:sweep`, `messaging.sweep.run`,
  `runMessagingContentSweep`, `content-sweep`, and `sweepCronSchedule`

Prefer existing SDK and Projects patterns before creating new UI primitives. If a shared shell is obvious after Messaging matches Projects, extract it separately.

## Boundaries

Always:

- keep Schedule scoped to cron/recurring jobs
- use tasks as the source of truth for agent work
- use `availableAt` only as dispatch eligibility
- preserve audit/history for in-flight work
- update tests and docs with behavior changes

Ask first:

- introducing new dependencies
- extracting new SDK/shared UI components
- changing runtime adapter contracts beyond task metadata

Never:

- reintroduce plugin-owned Messaging cron/sweep behavior
- use Schedule to wake Messaging business logic
- silently delete in-flight or external work
- preserve obsolete APIs only for backwards compatibility

## Implementation Checkpoints

1. Core task scheduling foundation.
2. Task board scheduled grouping/filter.
3. Workflow `createTask` node.
4. Cron bridge/docs cleanup.
5. Messaging sweep removal and activation model.
6. Messaging plan edit/delete impact handling.
7. Messaging UI overhaul.
8. Docs, generated references, full verification.
