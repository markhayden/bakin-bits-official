---
name: Dev Task
output_schema:
  type: object
  required:
    - deliverable
    - summary
    - tests_passed
  properties:
    deliverable:
      type: string
      description: The PR URL (preferred) or branch name holding the change. NOT a filesystem path or worktree path.
    summary:
      type: string
      description: One or two sentences — what changed and why, written for the reviewer.
    tests_passed:
      type: boolean
      description: Whether the test suite (and any new tests) passed in the worktree before handoff.
---

## Instructions

You're being asked to complete one dev task and deliver a reviewable PR or
branch. This is a workflow step, not a free-form chat — the system expects
exactly the output schema above and nothing more.

### 1. Read the brief

The dispatch message will give you some of:
- A `description` of the change (feature, fix, or integration work).
- A `repoPath` — the repository to change.
- Optional constraints (target branch, files in scope, "don't touch X").

If the brief is ambiguous enough that the implementation would change with
interpretation, block the task and ask — don't guess.

### 2. Isolate, then build

Apply the `git-isolation` skill FIRST: `bakin_exec_git_prepare_worktree`, then
work only inside the returned `worktreePath`. Never edit the shared checkout.

Build per the `dev-discipline` lesson: read the existing code before adding to
it, follow its patterns, test the happy path and one failure path. For API
integration work, enable the `api-integration` lesson.

### 3. Verify before handoff

- Run the project's test suite in the worktree; add tests for new behavior.
- `bakin_exec_git_status` — confirm the worktree state matches what you're
  about to report (no stray uncommitted files).
- Commit, push, and open a PR when the repo has a remote; otherwise deliver
  the pushed branch. The deliverable is the PR/branch, never a path.

### 4. Submit step output

```
bakin_exec_submit_step taskId=<id> stepId=<step> output={"deliverable":"<PR URL or branch>","summary":"<what changed>","tests_passed":<true|false>}
```

(Invoke Bakin tools as described in your **Tool access** section — the exact call form depends on the active runtime.)

If tests fail and you can't fix them within the task's scope, still submit —
with `tests_passed: false` and the failure in `summary`. Never report green
that isn't green.

After submitting, STOP. Do not merge the PR, do not deploy, do not start the
next step. Release the worktree (`bakin_exec_git_release_worktree`) once the
PR is open.
