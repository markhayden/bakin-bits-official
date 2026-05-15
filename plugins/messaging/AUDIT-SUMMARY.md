# Messaging Refactor Audit Summary

## Current Architecture

Messaging no longer owns a cron, sweep command, or Schedule integration.

Plans are strategic records. A Plan must define concrete `channels` before it
can be activated. Each Plan channel is a channel/content-type/publish-time
contract.

Activation creates:

- one `Deliverable` per Plan channel
- one board task per Deliverable
- task `availableAt` from `prepStartAt`
- task `dueAt` from `publishAt`
- task `source` pointing back to the Messaging Deliverable

The task board and dispatcher are the wakeup mechanism. Messaging does not poll
or schedule its own background work.

## Removed Paths

The following paths were intentionally removed:

- Messaging sweep module
- sweep tests
- sweep hook registration
- Messaging cron registration
- Schedule dependency
- runtime cron permission
- fanout route/tool/status naming

## Plan Lifecycle

1. A brainstorm session creates proposal records.
2. Approved proposals materialize into Plans in `needs_review`.
3. The user edits the Plan and configures concrete channels.
4. Activation creates Deliverables and scheduled kickoff tasks.
5. Dispatcher picks up kickoff tasks when `availableAt` is due.
6. Workflows or bare-task lifecycle move Deliverables through review and
   approval.
7. Failed Deliverables are recovered only through explicit drawer/API actions:
   restore approval, reopen prep, or retry delivery.

## Edit And Delete Rules

- Brainstorm delete removes only the brainstorm session.
- Plan delete removes the Plan, its Deliverables, and linked board tasks.
- Bulk Plan channel replacement is blocked after activation.
- Active channel deletion uses an explicit channel-delete route/tool that
  removes the channel, associated Deliverables, and linked board tasks.
- Deliverable delete removes the Deliverable and linked board task.

## Public Contracts

Routes:

- `POST /plans/:id/activate`
- `DELETE /plans/:id/channels/:channelId`
- `POST /deliverables/:id/restore-approval`
- `POST /deliverables/:id/reopen-prep`
- `POST /deliverables/:id/retry-delivery`

Exec tools:

- `bakin_exec_messaging_plan_activate`
- `bakin_exec_messaging_plan_channel_delete`

## Verification Focus

Regression coverage now asserts:

- activation registers no sweep hook and no cron job
- Schedule is not called even when Schedule hooks exist
- workflow bridge listeners are cleaned up on shutdown
- workflow-backed recovery uses Workflow hooks instead of direct state edits
- activation creates scheduled kickoff tasks with provenance
- repeated activation is idempotent
- Plan delete removes linked kickoff tasks
- channel delete is the only destructive channel-edit path after activation
