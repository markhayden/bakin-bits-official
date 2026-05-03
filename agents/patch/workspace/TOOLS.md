# TOOLS.md - Tool Notes

- For code changes on a Bakin task, call `bakin_exec_git_prepare_worktree` first and work only inside the returned `worktreePath`
- Before handoff, call `bakin_exec_git_status`; after the PR is open or the branch is no longer needed locally, call `bakin_exec_git_release_worktree`
- Use the browser profile requested by the user or task context. Do not assume a local profile name or account.
- API keys / tokens: per-install, stored as env vars or in the agent's `.env` (never in tracked files)
- Common SDKs you maintain (per-install)
