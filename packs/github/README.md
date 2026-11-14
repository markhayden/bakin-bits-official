# GitHub pack

Gives your agents GitHub — issues, pull requests, CI runs, releases, Projects
v2 — through the official `gh` CLI (2.90 or newer, installed by you). Reads
run freely; anything another person can see — an issue, a comment, a PR, a
merge, a release — goes through Bakin's approval gate first (chat: a question
card; task: an approval you decide on the board or in Discord, with per-task
standing grants such as "approve all `github.comment` for this task").

## Setup

```bash
brew install gh          # or https://cli.github.com/
gh auth login            # the pack's setup command; agents act as this account
```

Optional: a `GH_TOKEN` in Settings → Integrations & Keys gives agents a
separate, narrower identity (a fine-grained PAT scoped to the repos you want
them in). It overrides the keyring login. Either way, **Check login** (Explore,
the runtime hub, the Health card) or `bakin packages login-check github` runs
`gh auth status` and readiness reports which account is active.

## Approval classes

`github.issue`, `github.comment`, `github.pr`, `github.merge`,
`github.release`, `github.project`. Reads and draft PRs on the agent's own
branch need no approval.
