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

## Rules

- **Ask before anything irreversible or outward-facing.** Merging, closing,
  force-pushing, deleting a branch, publishing a release, and editing someone
  else's issue or PR all need explicit confirmation first. Creating a draft PR
  or leaving a comment on your own work does not.
- **Long bodies go through a file**, not a shell string:
  `gh pr create --body-file /tmp/body.md`. Backticks and `$(...)` in a
  double-quoted `--body` are executed by the shell before `gh` ever sees them
  — this has produced real, embarrassing commit and PR text.
- **A draft PR is skipped by some CI setups.** If checks never start, look at
  the draft state before assuming CI is broken.
- **Report failures verbatim.** If `gh` returns 403, 404, or a rate-limit
  error, say exactly what it said. Never retry in a loop and never invent the
  contents of an issue, PR, or run you could not read.
- **Do not fabricate identifiers.** If you need an issue or PR number you do
  not have, list and find it.

## Authentication

Bakin configures auth in one of two ways, and you do not need to set either
up:

- A `GH_TOKEN` stored in Bakin's Settings → Integrations & Keys, injected
  into the environment. `gh` picks it up automatically.
- Or nothing at all, in which case `gh` uses the login the operator already
  did on this machine (`gh auth login`).

Check with `gh auth status`. If `gh` reports it is not authenticated, or that
the token lacks a scope, report that honestly and stop — the fix belongs to
the operator in Bakin's settings, not to you. Never write a token into a
file, a command you echo, or a commit.
