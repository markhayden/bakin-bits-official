---
name: github
description: 'Work with GitHub through the `gh` CLI — read and file issues, open and review pull requests, watch CI runs, inspect diffs and releases, and call the REST/GraphQL API. Use whenever a task mentions a GitHub issue, PR, repository, workflow run, or a github.com URL.'
---

# GitHub

## Agent Directive

Use `gh` via the bash tool for anything on GitHub. Prefer it over raw `git`
for anything server-side (issues, PRs, runs, releases) and over hand-rolled
`curl` calls to `api.github.com` — `gh` already carries the auth, pagination,
and JSON shaping.

`gh` runs non-interactively here. Never invoke a command that would open an
editor, a pager, or a browser: always pass the content on the command line,
and set `--web=false` where a command offers it.

## Reading

```bash
gh issue list --state open --limit 20
gh issue view 742 --comments
gh pr list --state open
gh pr view 750 --json title,body,state,mergeable,reviewDecision
gh pr diff 750
gh run list --branch main --limit 5
gh run view 30575448224 --log-failed
gh release view v1.2.0
```

`--json <fields>` turns any list or view into structured output — always
prefer it when you are going to parse the result. Pair it with `--jq` only if
`jq` is available; otherwise read the JSON directly.

```bash
gh pr list --json number,title,author --limit 50
gh api repos/{owner}/{repo}/commits --paginate
```

## Writing

These change state on a real, shared service. Read the rules below before
using any of them.

```bash
gh issue create --title "..." --body "..."
gh issue comment 742 --body "..."
gh pr create --base main --head my-branch --title "..." --body "..."
gh pr comment 750 --body "..."
gh pr ready 751
```

## What needs approval

Approval is required for anything another person can see or that cannot be
undone. Each is an **action class** you name when you ask:

| class | operations |
|---|---|
| `github.issue` | create, edit, close, reopen, label, assign an issue |
| `github.comment` | comment on an issue or PR |
| `github.pr` | create a non-draft PR, mark ready for review, edit, close |
| `github.merge` | merge, delete a branch, force-push |
| `github.release` | publish or edit a release |
| `github.project` | Projects v2 item / field / status changes |

Reads (`list`, `view`, `diff`, `run view`, `api` GETs) and draft PRs on your
own branch need no approval. An operation not in the table → ask, with the
closest class or `github.other`.

**In a chat** (replying to the operator live): show the exact command and
what it does with `bakin_exec_ask_user`, and proceed only on a yes.

**In a dispatched task**: put long bodies in an asset first
(`bakin_exec_assets_save`; the run directory dies when your turn ends), then

```
bakin_exec_tasks_request_approval taskId=<id> action=github.comment
  command="gh issue comment 742 --body-file <asset path>"
  summary="Answer the repro question on #742" contentAssetId=<assetId>
```

`approved` (a standing grant covers this class) → run it. `pending` → END
YOUR TURN; the operator decides on the board or in Discord and the task
returns with the decision in its context. Never run while pending; never
re-ask for the same request. Resuming with an approved request: call
`bakin_exec_tasks_approval_outcome … outcome=attempting`, run EXACTLY the
recorded command, then report `done`, `failed` or `unknown`. An `unknown`
(lost response) means verify first — `gh issue view --comments` — never
re-post blindly.

## Rules

- **Long bodies go through a file**, not a shell string:
  `gh pr create --body-file /tmp/body.md`. Backticks and `$(...)` in a
  double-quoted `--body` are executed by the shell before `gh` ever sees them
  — this has produced real, embarrassing commit and PR text.
- **A draft PR is skipped by some CI setups.** If checks never start, look at
  the draft state before assuming CI is broken.
- **Report failures verbatim.** If `gh` returns 403, 404, or a rate-limit
  error, say exactly what it said. Never retry in a loop and never invent the
  contents of an issue, PR, or run you could not read.
- **Do not fabricate identifiers.** Issue numbers are repository-local; PRs
  show up in issue lists; Projects v2 items, fields and options have their own
  node ids — never copy a status label between projects. If you need a
  number or id you do not have, list and find it.
- **Projects v2 needs its own scope** (`read:project` / `project`); a token
  that reads issues may still be refused there — report it, do not retry.
- A `gh` GraphQL call can partially fail: treat any `errors` in the result
  as a failed operation, not a success.

## Authentication

Bakin configures auth in one of two ways, and you do not need to set either
up:

- A `GH_TOKEN` stored in Bakin's Settings → Integrations & Keys, injected
  into the environment. `gh` picks it up automatically.
- Or nothing at all, in which case `gh` uses the login the operator already
  did on this machine (`gh auth login`).

Check with `gh auth status` — its first line names the account you act as.
A `GH_TOKEN` in Bakin's keys OVERRIDES the keyring login, so that account is
the one that shows. If `gh` reports it is not authenticated, or that the
token lacks a scope, report that honestly and stop — the fix belongs to the
operator (`gh auth login`, or the key in Settings), not to you. Never write a
token into a file, a command you echo, or a commit.
