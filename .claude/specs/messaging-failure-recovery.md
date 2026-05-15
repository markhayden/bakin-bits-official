# Messaging Failure Recovery

Status: implemented and verified.

## Problem

Messaging deliverables can currently enter `failed` with no structured recovery path. The failure seen during testing was:

`workflow.complete fired but messaging-side status was in_review`

That means the workflow completed while Messaging had not recorded the user approval bridge correctly. The correct recovery is not to create new ad hoc work or publish immediately. The system needs explicit, user-driven recovery actions that preserve the original task/workflow chain wherever possible.

## Goals

- Make failures recoverable from the deliverable drawer.
- Keep tasks and workflows as the source of work execution.
- Preserve workflow-backed deliverables as workflow-backed deliverables.
- Route every cross-plugin operation through SDK hooks/adapters.
- Add structured failure metadata so the UI and routes can choose the right recovery action.
- Keep the first slice web/API only. Do not add MCP exec tools yet.

## Non-Goals

- No sweep, cron, maintenance task, or background repair process.
- No broad workflow retry UI outside Messaging.
- No recovery for `cancelled` or `published` deliverables.
- No automatic external publishing as part of restore/reopen actions.
- No generic "mark unrecoverable" action. Failed plus delete is enough for now.

## Invariants

- Recovery is always initiated by a user action in the drawer.
- The Messaging plugin never mutates Workflow plugin storage directly.
- The Messaging plugin never calls runtime internals directly to repair workflow state.
- Workflow repair happens through a Workflow plugin hook.
- Task repair happens through the task SDK.
- Plan status is derived from child deliverables except when the plan is explicitly cancelled.

## Failure Metadata

Extend `Deliverable` with structured failure fields:

```ts
type DeliverableFailureStage =
  | 'workflow_handoff'
  | 'validation'
  | 'delivery'
  | 'workflow'

interface Deliverable {
  failureReason?: string
  failureStage?: DeliverableFailureStage
  failedStep?: string
  failedAt?: string
}
```

`failureReason` stays human-readable. `failureStage` and `failedStep` drive recovery decisions.

Use a small helper for all failure writes so failure metadata is consistent:

- `workflow_handoff`: `workflow.complete` fires when Messaging status is not `approved` or `published`.
- `validation`: draft/assets/content validation blocks review, approval, or delivery.
- `delivery`: channel delivery throws or returns an unusable delivery reference.
- `workflow`: reserved for core workflow execution failures that Messaging can display but not repair in this slice.

For existing local failed records with no `failureStage`, the UI/API may derive the action from `failureReason` so the current failed runs can be recovered. The next mutation should persist structured metadata.

## Recovery Actions

### Restore Approval

Route: `POST /deliverables/:id/restore-approval`

UI label: `Restore approval`

Allowed when:

- Deliverable status is `failed`.
- Failure stage is `workflow_handoff`.
- Deliverable is workflow-backed.

Behavior:

1. Load the linked workflow instance through the Workflow plugin hook.
2. If the workflow cannot be loaded, return `409` and recommend `Reopen prep`.
3. If the workflow is not complete, return `409` and recommend `Reopen prep`.
4. Validate required draft/assets using the same validation used before publish.
5. Set deliverable status to `approved`.
6. Clear `failureReason`, `failureStage`, `failedStep`, and `failedAt`.
7. Keep `pendingGateStepId` as historical workflow context.
8. Recompute the parent plan status.
9. Audit and log the recovery action with the actual actor.

This action restores the deliverable to its scheduled/approved state. It must not call channel delivery and must not create or move tasks.

### Reopen Prep

Route: `POST /deliverables/:id/reopen-prep`

UI label: `Reopen prep`

Allowed when:

- Deliverable status is `failed`.
- Failure stage is `validation`, `workflow_handoff`, or `workflow`.
- The deliverable is not `cancelled` or `published`.

Behavior:

1. Move the deliverable to `changes_requested`.
2. Clear `failureReason`, `failureStage`, `failedStep`, and `failedAt` only after the linked task/workflow repair succeeds.
3. Clear stale `pendingGateStepId`.
4. Copy the failure reason into the task/workflow log so the next worker sees exactly what failed.
5. Recompute the parent plan status.
6. Audit and log the recovery action with the actual actor.

Bare task deliverables:

- If the linked task is still active enough to continue, reuse it.
- If the linked task is complete or otherwise cannot continue, create a normal repair task through the task SDK.

Workflow-backed deliverables:

- Do not create an unstructured repair task.
- Reopen the existing workflow task/instance through a Workflow plugin hook.
- Use `failedStep` when actionable.
- If `failedStep` points at a gate, the Workflow plugin resolves the previous actionable producing step.
- If no actionable step can be resolved, return `409` with a clear message.

### Retry Delivery

Route: `POST /deliverables/:id/retry-delivery`

UI label: `Retry delivery`

Allowed when:

- Deliverable status is `failed`.
- Failure stage is `delivery`.

Behavior:

1. Require explicit UI confirmation:
   `Retry delivery to <channel>? This may publish or send the content externally.`
2. Validate required draft/assets.
3. Call `runtime.channels.deliverContent` through the existing Messaging publish adapter.
4. On success, set status to `published`.
5. On failure, keep status `failed` and update `failureReason`, `failureStage`, and `failedAt`.
6. Recompute the parent plan status.
7. Audit and log the recovery action with the actual actor.

## Workflow Hook Contract

Add a narrow core Workflow plugin hook:

```ts
workflows.reopenFromStep({
  taskId: string
  instanceId?: string
  stepId?: string
  reason: string
  actor: { id: string; source: string; displayName?: string }
  metadata?: Record<string, unknown>
})
```

Return:

```ts
{
  taskId: string
  instanceId: string
  reopenedStepId: string
}
```

Rules:

- The Workflow plugin owns loading and saving the instance.
- If `stepId` is a gate step, resolve the previous actionable step reviewed by that gate.
- Reset the resolved step and downstream steps to pending/runnable state using existing Workflow plugin semantics.
- Reopen the same task instead of creating a replacement workflow task.
- Move the task back to active work through the task SDK/core task APIs owned by the Workflow plugin.
- Append a task/workflow log entry with the supplied reason and actor.
- Emit a workflow event such as `workflow.reopened` for audit visibility.
- Return `409` for missing instances, completed-but-not-reopenable state, or unresolvable steps.

Messaging only calls this hook. It does not reach into Workflow runtime files or state directly.

## Plan Status

Change plan status derivation:

- If `plan.status === 'cancelled'`, keep `cancelled`.
- If any active child deliverable is `failed`, the plan is `failed`.
- If the plan is currently `failed` but no active child deliverables are failed after recovery, recompute the normal derived status.
- If all child deliverables are terminal and none are published, the plan remains `failed`.

## Drawer UI

First slice is drawer-only.

- Show a compact failure panel in the deliverable drawer.
- Show the failure reason.
- Show only the recovery action that matches the current failure stage.
- Keep delete available as the fallback destructive action.
- Do not add recovery buttons to plan cards or calendar cards in this slice.
- Disable actions with clear inline text when the route returns a recoverability conflict.

## API Routes

Add deliverable routes using existing Messaging route patterns:

- `POST /deliverables/:id/restore-approval`
- `POST /deliverables/:id/reopen-prep`
- `POST /deliverables/:id/retry-delivery`

Each route returns the updated deliverable and enough parent plan state for the UI to refresh without guessing.

## Tests

Messaging plugin:

- Failure metadata is written for workflow handoff, validation, and delivery failures.
- `restore-approval` succeeds only for complete workflow handoff failures.
- `restore-approval` does not call delivery.
- `reopen-prep` moves failed deliverables to `changes_requested`.
- `reopen-prep` uses the Workflow hook for workflow-backed deliverables.
- `retry-delivery` requires delivery-stage failure and updates status correctly on success/failure.
- Plan status recomputes out of `failed` after all child failures are recovered.
- Drawer renders the correct single recovery action per failure stage.

Core Workflow plugin:

- `workflows.reopenFromStep` reopens the same workflow task/instance.
- Gate step input resolves to the previous actionable step.
- Downstream workflow steps are reset consistently with existing reject/rewind semantics.
- Missing/unresolvable instances return `409`-style failures to callers.

Full verification:

- Messaging targeted tests.
- Messaging plugin test suite.
- Core Workflow runtime tests.
- Typecheck and lint in both repos touched by the change.

## Commit Checkpoints

Ship in one PR, but keep logical rollback points:

1. Add failure metadata and plan-status recompute behavior.
2. Add the core Workflow `reopenFromStep` hook and tests.
3. Add Messaging lifecycle recovery functions and REST routes.
4. Add drawer recovery UI and component tests.
5. Update docs/knowledge and run full verification.

Implementation must stop after each checkpoint if tests expose a design mismatch rather than papering over it.
