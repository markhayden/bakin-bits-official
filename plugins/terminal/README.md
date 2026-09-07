# Terminal

Persistent, shared terminal sessions for Bakin users and explicitly enabled
agents. The Terminal navigation item opens the actual shell workspace, rendered
with xterm.js. Shell, Claude Code, and Codex use their installed local profiles
and normal permission prompts. Bakin does not disable CLI safety controls.

## Development Status

This is a macOS-first implementation, not a published release. It requires the
matching Bakin `feat/terminal-plugin` core/SDK changes: verified invocation
context, local plugin storage, Git session-worktree hooks, and required uninstall
preflight. The manifest's historical minimum version is not sufficient by
itself; select the actual release minimum before publishing. Do not install it
into an older production Bakin.

Prerequisites: Bun 1.3.13, tmux (tested with Homebrew tmux 3.7c), an active macOS
GUI login, and the Bakin Git plugin. Install `claude` or `codex` separately and
complete their normal authentication. The plugin does not manage subscriptions
or API billing.

## Setup and Access

1. Run the matching core in your development Bakin instance and install this
   plugin, or use `bakin plugins link <checkout>/plugins/terminal` for hot reload.
   An existing dev instance can use its normal Bakin home; a disposable home is
   only needed for isolated testing.
2. Open Terminal and choose **Set up service**. This explicitly installs a
   plugin-private launchd LaunchAgent. No service starts merely by importing the
   plugin. Linux service installation is not implemented.
3. Enable each allowed agent under plugin settings (`enabledAgents`, a list of
   `{ "id": "patch" }` entries). The default is no agent access.
4. Create a session. Coding CLIs default to an isolated Git worktree; **Existing
   checkout** is explicit. Shell sessions use the supplied working directory.

New Terminal loads the runtime agent roster and active tasks, plus named project
choices when Projects is installed. Disabled agents remain visible but cannot
be assigned. It defaults to the most recent valid non-worktree directory or the
host working directory, and the recent enabled agent or sole enabled agent.
Selecting an agent suggests its workspace; selecting a task fills available
agent/project links. Manually edited titles and directories are preserved.

Task/project links are optional. Task IDs are checked against the task service;
project IDs are navigation metadata, not ownership or cleanup authority. A
project link requires the Projects plugin. Completing a task never terminates
its shell.

The human sees all sessions. Agents can only see sessions assigned to them while
enabled. Take Control revokes agent input until Return Control; simply viewing
or disconnecting does not change ownership. Another browser tab must explicitly
take control. Reassignment revokes the previous agent's reads and writes.

## Agent Tool

`bakin_exec_terminal_session` accepts `operation` and an `input` object. Operations
are `list`, `create`, `screen`, `output`, `write`, `resize`, `interrupt`, `complete`,
and `terminate`. The host supplies verified agent identity; a body/query agent ID
does not grant access. OpenClaw MCP provisioning installs per-agent bearer
credentials; Pi uses its in-process invocation identity. Generic HTTP exec
cannot invoke this protected tool. Existing runtime tool allowlists still apply.

List/read the session before writing. Supply `id`, its current `generation`, and
`sequence: inputSequence + 1`. Input is at most 64 KiB. A stale generation or
sequence fails; never retry ambiguous input. Screen reads return bounded plain
text. Output reads accept a cursor and return base64 terminal bytes, the next
cursor, and an explicit truncation flag.

## Lifecycle and Retention

- A private tmux server is supervised independently of Bakin. Navigation,
  attachment failure, and Bakin restart do not terminate shells. Machine reboot
  and tmux-server failure do not preserve processes; unknown process state is
  never treated as permission to delete work.
- Complete refuses a live process. Terminate explicitly stops it. Dead tmux
  sessions are removed on completion. Bakin shutdown detaches only its clients.
- Ten live sessions and ten retained managed worktrees are separate defaults.
  At the worktree cap, safely eligible work is reclaimed or creation is blocked.
- Cleanup requires completion, no process using the path, no tracked/untracked/
  ignored changes, and the checkout's actual HEAD merged into its original base
  branch. Uncertain ancestry, squash merges, submodule changes, and unavailable
  checks retain work for review. Existing checkouts are never managed/deleted;
  Git branches are preserved.
- Maintenance runs at startup and hourly, with completion/capacity/task-done
  checks. An exited session idle for 30 days becomes cleanup-eligible, never
  forcibly discarded. `idleDays` is configurable. Live processes always block.
- Output payloads roll at 10 MiB/session and 250 MiB total. Screen parsing and
  stream pages are also bounded. Completed output expires after 30 days or can
  be deleted manually. SQLite page/WAL overhead is outside the payload budget;
  session metadata remains for ownership and retained-work review.
- Health reports unavailable service, maintenance failure, and retained work.
  Removal requires active preflight, no unfinished sessions or retained
  worktrees, and successful service shutdown. Linked plugins must use
  `bakin plugins remove terminal`, not bypass preflight through unlink.

## Security and Privacy

This is a trusted single-user host, **not an OS sandbox or hostile-agent
isolation**. A cwd/worktree is organization, not containment. Shells have the
host user's filesystem/network permissions. Any same-user process able to read
local credentials or send arbitrary host HTTP requests is inside that trust
boundary. Do not expose the service publicly or to untrusted users.

The service environment excludes Bakin-injected provider secrets. Login shell
profiles and CLI-local credentials remain accessible under normal OS rules.
Private sockets/data use restricted permissions. Terminal output is not sent
to shared activity, audit, or search; operation metadata may be audited by the
host, and agent tool results may enter that runtime's conversation history.
Output may contain sensitive content. Deletion is logical database deletion,
not a secure disk wipe or removal from external agent transcripts/backups.

## Verification and Preview

From the Bits root: `bun run test plugins/terminal/tests`, `bun run typecheck`,
`bun run lint`. Build with `BAKIN_SDK_DIR=<assembled matching SDK> bun run build`.
Browser fixtures require the assembled real SDK, not the repository's ambient
test SDK; use the repository's `ui:conformance` workflow. From this plugin, run
`bun run test:ui` once that SDK is installed, then inspect
`test-results/bakin-ui/index.html`.

Opt-in real process test:
`TERMINAL_PROCESS_TEST=1 bun test tests/processes.integration.test.ts --isolate`.
Add `TERMINAL_CLI_TEST=1` to check installed Claude Code and Codex interactive
startup without submitting prompts.
The launchd restart probe is `bun probes/session-survival.ts` from the Bits root.
Both use disposable services/data and clean up their owned processes.

Local preview: `bun plugins/terminal/tests/dev-server.ts` from the Bits root.
It prints a loopback URL and uses disposable state, not the user's Bakin home.
It enables only `patch` and has no Git hook integration, so coding sessions in
the preview require Existing checkout. Stop the preview to stop its shells.
Run `TERMINAL_PREVIEW_URL=<printed URL> bun test tests/browser.integration.test.ts
--isolate` from this plugin for live desktop/mobile browser verification.

The `/terminal` index uses `storybook/public/pages/page.stories.tsx` /
`CanonicalUsage` and `lists/list-rows.stories.tsx` / `InteractiveRows`.
Session detail uses `pages/workspace-page.stories.tsx` / `ImmersiveCanvas`:
full-width output, a compact Back link, and no session rail or navigation select.
`overlays/popover.stories.tsx` / `CanonicalUsage` holds assignment and details;
`overlays/dropdown-menu.stories.tsx` / `CanonicalUsage` holds completion actions.
All icon tools use `overlays/tooltip.stories.tsx` / `CanonicalUsage`, with
explanations on hover and keyboard focus, including disabled controls.
SDK `/patterns`, `/layout`, `/ui`, and `/navigation` own the page composition,
spacing, typography, tool controls, and empty/error states. Fit resizes the
terminal to available space only when this browser owns input; viewing does not
resize another owner's session. Back navigation never terminates the process.
xterm content/styles remain scoped to the plugin. Tab exits the terminal by
default; Capture Tab is explicit. Client markers use cryptographic random bytes
available on HTTP LAN/Tailscale origins, not secure-context-only `randomUUID`.
Request failures never imply that the terminal service needs installation.
No design-system exception or public UI extension is used.
