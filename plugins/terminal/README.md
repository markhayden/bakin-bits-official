# Terminal

Persistent, shared terminal sessions for Bakin users and explicitly enabled
agents. The Terminal navigation item opens the actual shell workspace, rendered
with xterm.js. Shell, Claude Code, and Codex use their installed local profiles
and normal permission prompts. Bakin does not disable CLI safety controls.

## Development Status

This is a macOS-first implementation. It requires Bakin and `@makinbakin/sdk`
`>=0.0.1-rc.42`: the client bundle is built for the host-provided zod contract
(`react19-sdk-focused-v2`, rc.42), and rc.40 added consent, verified downloads, and repair for
plugin-managed binaries.
That release includes verified invocation context, local plugin storage, Git
session-worktree hooks, and required uninstall preflight. The version used to
assemble SDK fixtures in CI is synthetic and does not define the production
compatibility requirement.

Prerequisites: an active macOS GUI login and the Bakin Git plugin. Bakin installs
a pinned, SHA256-verified tmux 3.7c into its managed bin directory during plugin
installation or upgrade, with the download disclosed for consent. The universal
binary supports Apple Silicon and Intel Macs; Homebrew is not required.
Install `claude` or `codex` separately and
complete their normal authentication. The plugin does not manage subscriptions
or API billing.

## Setup and Access

1. Run Bakin `0.0.1-rc.42` or newer and install this plugin, or use
   `bakin plugins link <checkout>/plugins/terminal` for hot reload.
   An existing dev instance can use its normal Bakin home; a disposable home is
   only needed for isolated testing.
2. Open Terminal and choose **Set up service**. This explicitly installs a
   plugin-private launchd LaunchAgent using the managed tmux first. No service
   starts merely by importing the plugin. Linux service installation is not implemented.
3. Enable each allowed agent under plugin settings (`enabledAgents`, a list of
   `{ "id": "patch" }` entries). The default is no agent access.
4. Create a session. Coding CLIs default to an isolated Git worktree; **Existing
   checkout** is explicit. Shell sessions use the supplied working directory
   unless `--worktree` (CLI) or the agent tool asks for an isolated one.

Terminal runs only Bakin's managed tmux (`~/.bakin/bin/tmux`); a tmux on
`PATH` (Homebrew or manual) is never used. If it is missing or damaged, open
Health and run the plugin assets repair, or run `bakin install plugin-assets`.
Terminal picks up the repaired executable without a Bakin restart.

The service's configuration comes from the plugin (`lib/tmux-config.ts`), and
setup records a fingerprint of the binary pin, configuration and program
arguments only after the restarted service is verified running it (it reports
the configuration's stamp and its options). A `clear` erases the screen
without copying it into scrollback (`scroll-on-clear off`), in tmux as in the
browser. When the
running service is not the one this plugin version sets up (another binary,
another configuration, or no verified fingerprint), Terminal and Health show
**Terminal service update available**. It is a recommendation: sessions keep
working on the running service until you apply it. **Apply update** (on the
Terminal list) opens a confirmation that lists any live sessions and offers to
end them first (setup needs none running), then restarts the service. Bakin
ends exactly the sessions you were shown: if one started or the update was
applied elsewhere meanwhile, nothing ends and the dialog says so; if one
cannot be ended, the update is not applied and the dialog names what did end.
Restarting drops tmux's own scrollback for ended sessions; output Bakin saved
and retained worktrees are kept. Health offers **Apply update** directly when
no session is live, and **Open Terminal** when some are. Setup also refuses a
service whose process state cannot be verified. Restarting the service drops retained tmux panes and their
in-memory scrollback; output Bakin stored and worktree records are kept. Linux
is not supported by this release.

New Terminal loads the runtime agent roster and active tasks, plus named project
choices when Projects is installed. Disabled agents remain visible but cannot
be assigned. It defaults to the most recent valid non-worktree directory or the
host working directory, and the recent enabled agent or sole enabled agent.
Selecting an agent suggests its workspace; selecting a task fills available
agent/project links. Manually edited titles and directories are preserved.
**Browse…** beside the working directory lists this Mac's folders (a browser's
own picker can only name files on the device it runs on): open folders, go up,
filter, show hidden ones, and pick from recent session folders; **Use this
folder** fills the field (it waits while a folder is still loading). It lists
folder names only (never files), filters on the server before its 500-folder
cap, and is guarded like Terminal's other browser routes (same origin, a
Terminal client id): not a barrier against other programs running as you.

Task/project links are optional. Task IDs are checked against the task service;
project IDs are navigation metadata, not ownership or cleanup authority. A
project link requires the Projects plugin. Completing a task never terminates
its shell.

The human sees all sessions. Agents can only see sessions assigned to them while
enabled. Take Control revokes agent input until Return Control; simply viewing
or disconnecting does not change ownership. Another browser tab must explicitly
take control. Reassignment revokes the previous agent's reads and writes.

## Sizing across devices

A session has one real grid. Exactly one screen sizes it, by an explicit
claim: the browser (or terminal app) that created it, or the last one where
someone chose **Fit to this device** in the header's size control
(`200×60 · Sized by this device | desktop | phone | terminal app`). That
screen keeps the grid fitted to its pane: height changes apply at once,
width changes after 100 ms. Viewing, typing, rotating, opening a keyboard, or
Take/Return control on any other screen never resizes anything. When the
sizing screen disconnects the header says **Size frozen** and the grid holds
until someone fits it again.

Every other screen renders the real grid locally. Its font is fitted to the
pane's width (never below 10px on touch screens, 8px elsewhere) and the pane
pans natively in both directions. Scrolling up or down (a wheel, a trackpad,
one finger) moves through the terminal's history while there is history that
way, and pans the grid otherwise; sideways scrolling pans. A finger drag
keeps going after it lifts. Pinch (or Ctrl+scroll on a trackpad) sets a font
for this device, remembered in this browser; **Reset view** returns to the
fitted font. The view follows the cursor after each update; panning,
scrolling into the history or selecting text pauses that until **↓ Live**
(Follow cursor) or focusing the terminal to type — reaching the bottom by
itself does not. Both controls sit small in the pane's top-right corner,
never over the bottom rows where the program's input line is, and tapping
them keeps the keyboard where it is. Scrolling and panning never open the
keyboard or send input, with one exception that matches native terminals: a
full-screen program that asked for the mouse (Claude Code, vim with mouse on)
scrolls itself, so the wheel and vertical drags reach it as scroll events
(one per row) once the grid has panned to its edge — on the new viewer, for
programs that use the SGR mouse encoding, as Claude Code does. A full-screen program that did not ask
for the mouse gets no arrow keys from scrolling, and a tap never reaches a
program as a mouse click (a mouse click on a desktop still does, as in any
terminal).

Session actions › **Use this size as the default** saves the current grid as
the Default columns/rows for new sessions nobody's screen sized yet (agent
sessions).

## The new terminal viewer (preview)

Settings › **Use the new terminal viewer for new sessions (preview)** (off by
default) gives new sessions a viewer that shows the same picture on every
device, reflowed exactly as tmux does when a width changes. If the view ever
has to be refreshed from tmux (very fast output, a lost connection to tmux, a
difference the safety net found), the session shows a persistent notice
naming why (on a phone it folds to its title; **Show details** opens the
rest). When a session ends its last screen is kept, so an ended session
opens to what it showed.

When a program in the session offers text for the clipboard (OSC 52 —
Neovim with OSC 52 clipboard, or `… | base64 | xargs -0 printf
'\033]52;c;%s\a'`), this viewer shows **Text to copy** in the pane's corner
with its first line that has text and a **Copy** button. Nothing writes your
clipboard until you tap it; a newer offer replaces the last, a copied one goes
after its check, a refused copy keeps it to try again, and **×** dismisses it.
Opening, reloading or reconnecting never brings an old offer back. tmux's own
copy mode sends its copies to attached terminal apps, not to this viewer.

To copy terminal text on a phone (the terminal has no touch selection),
choose Session actions › **Copy text…**: the history and screen open as plain
text in a sheet, where the system's own long-press selection works, with
**Copy all** (every line, even past the 2,000 shown) and **Refresh**.

A session keeps the viewer it started with until it ends: turning the
setting off starts new sessions with the current viewer, and open ones are
unchanged. Either way a program's query is answered once, by tmux. The
current viewer still records each session's output, so going back (or
installing an earlier Terminal) keeps every ended session readable.

## Continue in a terminal app

Any running session you drive can also be open in Ghostty (or any terminal) on
this Mac, and vice versa:

- `bakin terminal new --as human` starts a shell in the current directory,
  titled after it, and attaches this terminal. `--program claude|codex` runs a
  coding CLI instead, `--worktree` works in a new isolated Git worktree (any
  program, shells included), `--title` names it, and `--agent <id>` assigns an
  agent without handing it control.
- `bakin terminal attach <ref> --as human` continues an existing session.
  `<ref>` is the full id, a unique id prefix of at least 8 characters, or an
  exact title; an ambiguous one lists the candidates. Session details in the
  browser show the short id and a copyable attach command.
- `bakin terminal ls --as human` lists sessions: id, title, program, owner,
  state, size, directory, and how many terminal apps are attached.

While attached, `Ctrl-b d` detaches, `Ctrl-b [` scrolls back, and closing the
window also detaches; the session keeps running in Bakin. Attaching makes the
terminal app the screen that sizes the session (the header says **Sized by
terminal app**), and its window resizes are followed until another screen
chooses **Fit to this device**. The browser shows **Open in a terminal app**
while one is attached.

Only the operator attaches, from a terminal (not inside tmux, an agent shell,
or a remote `BAKIN_URL`). An agent-driven session refuses with "Take control
first", and **Return control** detaches terminal apps before the agent types
again. Every attach is a single-use reservation the CLI confirms within 15
seconds; any other tmux client on a session, including a hand-typed
`tmux attach`, is detached at once. A Bakin restart detaches attached terminal
apps; attach again.

## Agent Tool

`bakin_exec_terminal_session` accepts `operation` and an `input` object. Operations
are `list`, `create`, `screen`, `output`, `write`, `interrupt`, `complete`,
and `terminate`. Agents never size a session: agent-created sessions start at
the Default columns/rows settings (200×60), and every `screen` reports `cols`,
`rows` and `sizeRevision` so an agent re-reads after a human resizes. The host supplies verified agent identity; a body/query agent ID
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
- Bakin holds two tmux clients per live session:
  - an attached client whose redraw stream is the output, and from which a reconnect recovers;
  - a control-mode client (`tmux -C`) that carries input, resizes and queries,
    and the program's own output (`%output`, read as bytes): it feeds the
    session's ordered event log (output and layout changes, batched, bounded
    at 8 MiB queued; a lost connection or a stalled reader invalidates it).
    The log feeds the session's server replica, which runs in shadow mode
    for now: viewers still render the attached client's redraws, and at
    quiet points the replica's screen is compared with them in the server
    log (kinds and rows, never contents). A replica starts from a seed:
    one grouped command (history, screen and modes in one capture) whose
    reply places it in the log, so no output is lost or repeated around
    it. It keeps a checkpoint plus the output since (bounded at 4 MiB or
    4096 events): Bakin's own serializer (every cell, both buffers, saved
    cursors, charsets, modes, links, the grapheme join state), accepted
    only when restoring it into a fresh terminal reproduces the full
    state, and taken in slices of a few milliseconds that never hold up
    input. tmux can deliver a flood (`yes`) about twice as fast as the
    replica parses it; past 4 MiB behind, the replica skips the output and
    rebuilds from tmux (at most once a second while the flood lasts), so
    the log never overflows.

  Neither one sizes the window (`window-size manual`): only Bakin's explicit
  resize does, so an extra client, such as a terminal app, never reshapes a
  session. Typed input is delivered byte-exact with `send-keys -H` and never
  passes through tmux key bindings; a paste is handed to tmux as a paste
  (`paste-buffer -p`, byte-exact), so tmux brackets it only when the program
  asked for bracketed paste. A pane left in copy mode is returned to its
  program first.
- **Each browser holds one WebSocket to the session** (`/api/plugins/terminal/socket`).
  - The connection opens with a sync: a snapshot of the screen, the cursor it
    reflects, and the session's ownership, input sequence and size.
  - Output follows as binary frames as soon as it is stored. The browser
    acknowledges what it has drawn, and the server never runs more than
    256 KiB ahead of a viewer. A viewer stuck behind for 10 s is disconnected
    and resyncs, so a stalled phone never slows a desktop.
  - Keystrokes are batched while one is in flight. Every input batch gets an
    answer: an error reads **Input not sent** when it was refused, or **May
    have been delivered** when the connection dropped mid-delivery. Input is
    never replayed.
  - The browser reconnects by itself with backoff. After the page has been in
    the background for more than a few seconds, or when the network comes back,
    it takes a fresh connection and sync, so a phone returning from the
    background picks up where it left off, even if its old socket only looked
    open. Input that was mid-flight when a connection dropped reads **May have
    been delivered**; input still queued reads **Input not sent**. Opening the
    same session in another tab is fine; each tab has its own connection.
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
  output pages are also bounded. Completed output expires after 30 days or can
  be deleted manually. SQLite page/WAL overhead is outside the payload budget;
  session metadata remains for ownership and retained-work review.
- Health reports unavailable service, maintenance failure, retained work,
  and live sessions holding more than 640 MB of Bakin's memory (estimated
  each minute from the emulators' structure; a session of 10,000 rows of
  ordinary output is about 23 MB, more with an emoji or link in every cell).
- A cell keeps at most 32 bytes of text, as tmux does; titles past 4 KiB
  are ignored.
  Removal requires active preflight, no unfinished sessions or retained
  worktrees, and successful service shutdown. Linked plugins must use
  `bakin plugins remove terminal`, not bypass preflight through unlink.

## Security and Privacy

This is a trusted single-user host, **not an OS sandbox or hostile-agent
isolation**. A cwd/worktree is organization, not containment. Shells have the
host user's filesystem/network permissions. Any same-user process able to read
local credentials or send arbitrary host HTTP requests is inside that trust
boundary. Do not expose the service publicly or to untrusted users.

The service environment excludes Bakin-injected provider secrets, but that is
not a sandbox: an enabled agent's shell can still read those secrets — and other
agents' host credentials — from disk under normal OS rules, so it can act
outside its own identity. Enable terminal access only for agents you trust with
full access to this machine. Login shell profiles and CLI-local credentials
remain accessible under normal OS rules.
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
--isolate` from this plugin for live desktop/mobile browser verification;
`tests/handoff.browser.test.ts` also needs `TERMINAL_PREVIEW_TMUX` (the
printed `tmux`) to attach a terminal app.

The `/terminal` index uses `storybook/public/pages/page.stories.tsx` /
`CanonicalUsage` and `lists/data-table.stories.tsx` / `ActivatableRows`.
The index has Session, Program, Agent, Status, and Working directory columns;
flexible cells wrap to fill the available width instead of forcing horizontal
scrolling. Explicit widths and intrinsic controls may still require local
scrolling on narrow screens. The kit owns keyboard row activation and excludes
nested menu, link, and portalled events from it. Each row has a tooltip-labelled
actions menu for taking control, completing an exited session, terminating, or
deleting completed output. Destructive confirmations name and retain the target
session ID; deletion retains session metadata. Ownership checks still apply.
Session detail uses `pages/workspace-page.stories.tsx` / `ImmersiveCanvas`:
full-width output, a compact Back link, and no session rail or navigation select.
Session controls occupy the right-hand title-row actions in both full and compact
headers. New terminal is available on the index, not inside a session.
`overlays/popover.stories.tsx` / `CanonicalUsage` holds assignment and details;
`overlays/dropdown-menu.stories.tsx` / `CanonicalUsage` holds completion actions.
All icon tools use `overlays/tooltip.stories.tsx` / `CanonicalUsage`, with
explanations on hover and keyboard focus, including disabled controls.
SDK `/patterns`, `/layout`, `/ui`, and `/navigation` own the page composition,
spacing, typography, tool controls, and empty/error states. Sizing is
described below; driving input never resizes anything. Back navigation never
terminates the process.
Agent assignment uses the same full-width kit field and registered display
name, portrait, and accent color as Tasks; terminal enablement remains a
separate permission gate.

Manual shell smoke test:Title `Manual shell test`, Program `Shell`, Working
directory `/tmp`, Assigned agent `Unassigned`, Task `No task`, Project
`No project`. Start the terminal and run `pwd` and `printf 'terminal test OK\n'`.
The prompt should follow the pane as it changes (this screen created the
session, so it sizes it). Use Session
actions / Terminate and complete to finish the test.
xterm content/styles remain scoped to the plugin. The output has a kit `p-bakin-4`
inset; xterm's theme and unused viewport use the same canvas background as that
inset. The fit addon measures the inner host, leaving padding outside the grid.
Connection and ownership status share the title header; there is no separate
stream toolbar. Session actions contains Reconnect terminal (reattach output,
not restart the shell) and the kit toggle Capture Tab, on by default. While on,
Tab reaches the shell for completion; turn it off to let Tab move focus out of
the terminal.
The composition uses `overlays/dropdown-menu.stories.tsx` / `Actions` and
`layout/bounded-overflow.stories.tsx` / `CanonicalUsage` with the approved keyboard-aware WorkspacePage extension.
Client markers use cryptographic random bytes
available on HTTP LAN/Tailscale origins, not secure-context-only `randomUUID`.
Request failures never imply that the terminal service needs installation.
No design-system exception is used; the shared workspace extension is defined in public Storybook.


## Mobile input and rendering

Terminal automatically uses xterm's WebGL renderer when available. GPU startup failure, context loss, or inconsistent browser pixel-scale measurements fall back to the normal renderer; reconnecting creates a fresh renderer. Pixel measurements are refreshed when display density changes, including mobile emulation changes that leave the pane the same size. No setting or separate transport is needed.

Phones and tablets show a key bar while you are typing in the terminal: tap the terminal, or the corner **Show keyboard** button. The bar is one row of keys styled like the iOS keyboard: **esc**, **⇥**, **⌃** (Control), **⌥** (Option, the terminal's Meta: it sends ESC first), **•••**, and **Hide keyboard**, which is always there and ends the typing session. Return on the on-screen keyboard sends the line and puts the keyboard away, so the response has the screen (a hardware keyboard's Enter keeps you typing). Tap ⌃ or ⌥ to apply it to the next key; lock it from the key sheet to hold it until you tap it again. **•••** puts the keyboard away and shows the key sheet in its place: Esc, Tab, ⇧Tab, Enter, Backspace, Delete, all four arrows, Home/End, Page Up/Down, `|` `~` `/` `-`, the Control shortcuts with plain labels (^C Interrupt, ^R Search history, …), and the Control and Option locks. **abc** brings the keyboard back. Keys keep focus on the terminal, so the keyboard stays up while you use them. ⌃ and ⌥ apply to the next single key the terminal receives (a letter typed, dictated or committed by an input method, an arrow, Escape); words, longer dictation and paste are sent as typed, and a typed Backspace is always a plain Backspace (use the sheet's ⌫ for ⌥⌫); a disconnection, a change of who is driving, or leaving the page releases every modifier. Desktops show no key bar. Opened from the Home Screen (Share › Add to Home Screen), the bar sits right on the keyboard; in a Safari tab, Safari keeps its own address bar between them.

Web addresses in the output are links (plain-text URLs as well as the hyperlinks programs print): open one and the browser asks first, then opens it in a new tab that cannot reach back to Bakin. Only http, https and mailto links open.

**Compose** (in the key sheet) opens a text box in place of the keys, for dictation, an input method, or a longer edit before sending: **Paste** sends it to the program as one paste and puts you back in the terminal; **Paste + Enter** sends it with Return and puts the keyboard away. Each session keeps its own draft in this browser until the paste is accepted; one that is refused or may not have arrived stays, so you can check it and send it again yourself. A paste is at most 64 KB. A paste from the terminal or the compose sheet reaches the program bracketed (the markers a shell or editor uses to tell pasted text from typing) only when the program asked for them: tmux, which knows the program's mode, delivers it.

Sending keys are disabled while watching, disconnected, or changing ownership (Hide keyboard still works); use Take over to drive. Ended sessions and deleted output have no key bar. Normal/application cursor modes use the current xterm mode. All keys pass through the viewer connection's ordered input. A screen that sizes the session never shrinks it below 40×10; a shorter pane (a phone keyboard) pans over the floored grid. Physical Tab follows Capture Tab while input is available.

The shared references are `pages/workspace-page.stories.tsx — KeyboardAwareInput` and `recipes/terminal-input.stories.tsx — CompactAndExpanded`. The kit owns viewport measurement and the reserved accessory slot; the plugin owns key encoding, the editing session and modifier state, and ownership. The recipe is being updated to the v2 bar (spec D9 item 9, task T18d).

Browser checks against a disposable preview: `TERMINAL_PREVIEW_URL=<url> bun test tests/mobile-input.browser.test.ts tests/renderer.browser.test.ts tests/links.browser.test.ts --isolate`. Set `TERMINAL_BROWSER=webkit` to repeat with WebKit. The installed-SDK UI fixture now exercises session detail and disabled keys. A physical iPhone Safari and Android Chrome keyboard check is still required; desktop emulation does not prove native keyboard behavior.
