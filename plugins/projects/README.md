# Projects Plugin

Shape a project in conversation with an agent, then track it to done: a
markdown plan, steps that link to board tasks, the files the work produced,
and one project conversation that stays with it the whole way.

## Starting a project

"New project" opens the start screen at `/projects/new` — there is no form or
modal. It asks "What kind of project is on your mind?" with six starter chips.
A chip only pre-fills the composer with an editable sentence; nothing is
created until you send. The lead-agent picker sits beside the composer
(default: the main agent). A list with no projects at all shows the start
screen directly.

The first send creates the project and starts its first conversation turn.
The client mints a `requestId` when you press send; `POST /` with `requestId`
+ `firstMessage` writes a draft project (title = the first message trimmed to
60 characters, `titleSource: 'fallback'`) with a kickoff receipt, then starts
the first brainstorm turn on the same path as `/ask`. A retried create —
lost response, double click — returns the same project and never a second
turn. If the server dies before the turn starts, the boot resume starts it
once. A failed create keeps your text in the composer; the retry reuses the
same `requestId`.

## The project page

The header holds the title, the status badge and ONE next-step button:
**Start project** (draft — the hand-off, below), **Mark complete** (active;
when steps are unfinished it names them and asks "complete anyway?"),
**Reopen** (completed), **Unarchive** (back to the status it was archived
from). There is no status picker. The ⋯ menu has Pause/Resume check-ins
(active projects; a "Paused" badge shows while paused), Archive, Details
(lead agent, created/updated, ID) and Delete. The pencil beside the title
renames the project in a dialog.

Below it, four tabs — **Conversation · Plan · Steps · Files** (`?tab=`). A
project opens on what matters at its stage: draft → Conversation, active →
Steps, completed → Files, archived → Plan.

The conversation is the main surface. On its tab it takes the full width;
beside Plan, Steps and Files it is docked on the right on desktop (the
public `PageAside` conversation-width rail), collapsible to a slim strip with
the lead's avatar and a working/unread marker. Exactly one composer is ever
mounted, so the draft follows you between tabs. On mobile there is no dock —
an "Ask {lead}" button opens the Conversation tab.

## Working with the lead

The lead's posture follows the project's stage, from one shared builder
(`lib/brainstorm-prompt.ts`) used by `/ask`, the kickoff turn and
`bakin_exec_projects_ask`:

- **Draft — shaping.** A brainstorm buddy: a brief reflection, at most one
  challenge, and ONE question card per turn (`bakin_exec_ask_user`, with a
  recommendation that is never preselected). Once the goal, scope and
  definition of done are answered it drafts the plan and steps and says
  "Draft plan is ready in the Plan tab". "Just write it" skips ahead.
- **Active — progress.** What is blocked, what is next, whether scope holds;
  no interviewing. Between your conversations the lead also checks in on its
  own (below).
- **Completed / archived — retrospective.** Answers only.

The lead names the project once it understands it, unless you already did.

Agent writes pass ONE authority check: agents never change lifecycle status
(the `status` parameter is gone from `bakin_exec_projects_update` and
`_apply_plan`), never overwrite a title you typed (`titleSource: 'user'` —
refused with `title_locked`), and never delete steps or projects (there
are no agent remove/delete tools; deleting is a UI action). REST follows the same rule: the Projects UI declares the
operator (`X-Bakin-Operator: declared`, the SDK's
`OPERATOR_DECLARATION_HEADERS`) on every mutation, and a caller from an agent
context (`X-Bakin-Agent-Context`) or without the declaration is held to the
agent rules — declared, not verified, the same documented limit as
approvals. The composer's agent picker is for one-off consults; the lead
answers by default. The composer's paperclip uploads a file to the asset
library and attaches it to the project's Files.

## Check-ins (the steward)

**Start project** is a hand-off: "{Lead} takes it from here — sends steps to
the board, assigns each to the right agent or keeps it, and checks in as work
moves. You'll be asked when a decision or sign-off is needed." The dialog
shows the step count and a "Review steps first" link. Confirming makes the
project active and reserves the lead's first check-in at once (with no steps
yet, it breaks the plan down first). A reopen is not a hand-off.

**When the lead checks in.** A cheap, deterministic scan (no model call)
looks at every Active project every `stewardScanMinutes` (default 15), and
within ~30 s when a work task reaches done, blocked or review. It reads the
project and its board tasks into a digest of signals — blocked tasks, a review
idle past `stewardStuckAfterHours` (default 24), steps not on the board with
nothing in flight, work finished since the last check-in, every step done, or
no movement at all for the window. Check-in tasks never count as work. The
digest has a fingerprint (signal kinds, task columns, steps, plan revision —
no timestamps); a check-in is created only when the fingerprint changed, or
when the same unresolved situation has lasted a whole window (one re-raise
per window). Progressing work, or a situation already handled, creates
nothing. Paused, waiting-on-you and completion-pending projects are skipped.

**A check-in is a board task** — "Check in: {project}", assigned to the
lead, tagged `project-steward`, sourced `projects/steward/<projectId>` — so
it gets budget gating, the watchdog, metering (dispatch work) and board
visibility like any task, and a models tag route on `project-steward` can
send it to a cheaper model. At most one is open per project: it is reserved
in the project file (pre-minted id + frozen title/assignee/brief) before it
is created, so the timer, an event, Start and a crash all converge on the same
task. Each scan first reconciles the reservation against the board (create a
missing reserved task; finalize a finished or deleted one). At most
`stewardMaxRunsPerDay` (default 6) per project per local day; past that the
row says "Check-ins paused for today".

**What the lead may do on its own:** send existing steps to the board
(keeping each or assigning the best agent), add steps or tasks that follow
from the agreed plan, make small plan edits (snapshotted like every edit),
re-describe or reassign blocked tasks, nudge idle reviews. **What needs
you:** changing scope, dropping or deleting steps, spending beyond the plan,
signing off a deliverable, completing the project. Enforced by the server:
no status changes, no step deletion, no overwriting your title. Advisory (in
the check-in's instructions, not enforced): scope and spend.

**Check-in tools** (each takes the `taskId` from its check-in task; anything
but the project's open check-in is refused with `not_steward`, or
`use_ask_user` from inside the project conversation):

- `bakin_exec_projects_checkin` — "Checked in: …" plus the actions taken,
  posted to the project conversation as the lead (the check-in's own turn).
- `bakin_exec_projects_request_input` — ONE question card in the project
  conversation, with an attention notification and "Waiting for you" on the
  list. Check-ins pause until you reply; your reply's turn carries the
  question and the lead's reasoning, and the gate ends when that turn settles.
  A newer question replaces an open one.
- `bakin_exec_projects_request_signoff` — a Bakin approval you decide on the
  board (the "Needs approval" card on the check-in task; the list says "Needs
  approval"). `complete`: approve completes the project, reject sends your
  reason to the conversation and the loop carries on. `signoff` (a
  deliverable): approve marks it done, reject sends it back to todo with your
  reason on the task and in the conversation. Agents can never decide.

Rows written outside a conversation turn queue behind a running turn and
land right after it — never inside it.

**Completing or archiving** a project — by hand or by approving its
completion — archives the open check-in, cancels other pending sign-offs and
clears an open question. **Pause check-ins** (⋯) stops the loop without
changing the status.

## Plan

The Plan tab renders the plan with change hints against the previous
version, a History view (line diff + restore), and **Edit plan**
(`?edit=1`) — the editor and one SaveBar in place. The plan draft lives at
page level, so switching tabs keeps it. An agent edit that overlaps your
draft asks you to choose: Use latest plan or Keep my plan.

Every committed body change bumps `planRevision` (no-op writes don't;
restores do) and records `planUpdatedBy`/`planUpdatedAt`. When an agent
revision is past the one you last saw, the Plan tab shows a dot and the
conversation shows "Plan updated {age} · Review changes", which opens the
history compared against the version you last saw. Opening the Plan tab marks
the current revision seen (`POST /:projectId/plan/seen`); your own edits are
seen by definition. Nothing is injected into the transcript.

## Steps

Steps are the plan's checklist: progress as "n of m steps done", independent
row drafts, durable add/promotion receipts, and Hide done. **Send to board**
promotes a step to a board task; a linked step then shows its board state in
words ("In progress · Roscoe", "Done · board") and an **Open task** link.

A linked step's completion is derived, never synced: it is checked exactly
while its board task is done or archived, so reopening the task unchecks it.
`deriveChecklist(project, board)` is the one source of `checked`/`progress`
for the detail, list, brainstorm context, task enrichment, search and tool
returns. Toggling a linked step — UI, REST or tools — is refused with
`linked_step`. A board column change only tells open pages to refresh. No
task-deletion event reaches plugins, so loading a project unlinks (durably)
any step whose board task is gone, and it becomes a normal step again.

## Files

Two groups: **From this project's work** — what the project's board tasks
produced (linked steps plus tasks carrying the `projectId`), derived live
through the assets plugin's `assets.listByTask` hook by
`GET /:projectId/files`, never stored — and **Attached**, with attach,
relink, detach and preview. A file in both shows once, under Attached.

## Projects list

Separated `ListRows`: each row shows the title, status (+ "Paused") and ONE
resume signal by priority — Needs approval (a pending sign-off) › Waiting
for you (an unanswered question card) › {Lead} is working › New reply from
{Lead} › Stuck (blocked, idle review or stalled — the check-in digest) ›
Plan updated › Check-ins paused for today › "n of m steps done". "All"
leaves archived projects out; they keep their own filter. A row's ⋯ menu
deletes the project (linked board tasks and asset files are kept; a running
conversation is stopped).

Public references and evidence: [UI-AUDIT.md](UI-AUDIT.md).

## Host prerequisite and mutation storage

Projects requires the companion Bakin host's atomic scoped-storage replacement
and an SDK with structured questions (`bakin_exec_ask_user`) and the
conversation-width `PageAside` rail.

Frontmatter additions are all optional with defaults — no migration:
`titleSource` (absent ⇒ `user`), `kickoff`, `planRevision` (absent ⇒ 0),
`planUpdatedBy`, `planUpdatedAt`, `archivedFrom`. Stored `checked` on a linked
step is ignored.

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
conversationThreadId('projects', projectId, agentId)
```

The same `projectId + agentId` pair reuses the same runtime conversation
through the active adapter. Stored brainstorm messages are for UI hydration and
traceability, not prompt-history replay.

## Brainstorm Storage

Brainstorm messages use the project's `.brainstorm.json` sidecar in the same
plugin-scoped directory as the Markdown project. It stores the conversation kit's
user, assistant, tool, error and aborted rows, bounded to 300 rows; a question
card's tool row keeps its `metadata.bakinQuestion`. A separate
`.brainstorm-seen.json` records what the user has seen — `lastSeenAt` for replies
and `planSeenRevision` for the plan — and its fields merge on write.
`.history.json` holds the newest 20 prior plan bodies, each with the revision it
was, plus the snapshot at the seen revision while it is the comparison baseline.
These files do not replace the composer's existing draft persistence.

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

Check-in state rides the same frontmatter, strictly validated on read:
`steward` (the open reservation — `openTaskId`, `phase`, the frozen create
inputs — plus `lastFingerprint`/`lastStewardAt` and the day's `runs`),
`waitingOn` / `replyPending` (an open question and its reply turn),
`gates` (`<gateKind>:<subject>` → approval id, generation, state, the check-in
that asked) and `stewardPaused`. Bookkeeping writes never touch `updated`.
Settings (Settings → Projects): `stewardEnabled`, `stewardScanMinutes`,
`stewardStuckAfterHours`, `stewardMaxRunsPerDay`.

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

Unit tests run against the `test-sdk` stubs (`bun run test` at the repo root):

- `tests/routes.test.ts` — routes and exec tools: kickoff idempotency and boot
  resume, the authority rules, derived steps, plan revisions/seen, produced
  files, list resume signals, thread IDs and streaming
- `tests/service.test.ts`, `tests/project-conflicts.test.ts` — the service:
  derived completion, revisions and the pinned baseline, expected-value writes
- `tests/brainstorm-prompt.test.ts` — the staged posture
- `tests/start-screen.test.tsx`, `tests/project-header.test.tsx`,
  `tests/project-detail.test.tsx`, `tests/steps-tab.test.tsx`,
  `tests/project-list.test.tsx`, `tests/project-row.test.ts`,
  `tests/plan-draft*.test.ts*`, `tests/project-uploads.test.tsx` — the UI

Browser fixtures need the real SDK. Root `BAKIN_SDK_PACKAGE_DIR=<assembled
sdk> bun run ui:conformance` copies this package, installs that SDK and runs
`test:ui` (the list) and `test:ui:collections` — plan spacing, every detail
surface (`PROJECTS_UI_SURFACE=conversation|plan|steps|files|start`) at desktop
and mobile, and `tests/detail.browser-test.ts` (one composer across tabs and
dock states, draft retention, lost-add retries, partial Save all, "Plan
updated" review, the mobile Ask button, 200% text, history retry). Reports
land under `test-results/bakin-ui-*`.
