import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from './contracts'

/**
 * Attention (spec item 5): what a coding program says about its turn, set by
 * the program's own hooks as the pane option `@bakin_attention` and read
 * through the control client's subscription. A shell has no semantic state.
 */
export const ATTENTION_STATES = ['needs-you', 'turn-finished', 'working'] as const
export type AttentionState = typeof ATTENTION_STATES[number]

/** A subscription value: one of the states, or nothing (cleared, unset, or anything else). */
export function parseAttention(value: string): AttentionState | undefined {
  const trimmed = value.trim()
  return (ATTENTION_STATES as readonly string[]).includes(trimmed) ? trimmed as AttentionState : undefined
}

/** The pane option and the control client's subscription to it. */
export const ATTENTION_OPTION = '@bakin_attention'
export const ATTENTION_SUBSCRIPTION = 'bakin-attention'

/**
 * Bells, as tmux's own parser decides them (it is the terminal the program
 * writes to, so a title's BEL or one inside a control string is none): a
 * per-session `alert-bell` hook counts them in a session option the control
 * client subscribes to. Set at attach, not in the tmux configuration, so the
 * service is unchanged.
 */
export const BELL_OPTION = '@bakin_bell'
export const BELL_SUBSCRIPTION = 'bakin-bell'
export function bellHook(sessionId: string): string[] {
  return ['set-hook', '-t', sessionId, 'alert-bell', `set-option -F -t ${sessionId} ${BELL_OPTION} "#{e|+:#{${BELL_OPTION}},1}"`]
}

/**
 * Hooks run under the program (`env -i` stripped TMUX): these name the
 * managed tmux, its socket and the session, so every hook command line is the
 * same in every session — Codex trusts a hook by its definition's hash, and a
 * definition that changed per session would need trusting every time.
 */
export const ATTENTION_ENV = { tmux: 'BAKIN_TERMINAL_TMUX', socket: 'BAKIN_TERMINAL_SOCKET', target: 'BAKIN_TERMINAL_SESSION' } as const

/**
 * How a hook's state applies: `always`; `main`, only from the main agent (a
 * subagent's hook input has a top-level `agent_id`, and its tool runs never
 * reset the operator's state); `stale`, only over `working` or `needs-you` (a
 * turn the operator interrupted, which no hook reports, left them behind) —
 * decided by tmux in one command, so a newer state is never erased.
 */
export type HookScope = 'always' | 'main' | 'stale'

/** Exits 0 when the JSON on stdin has `agent_id` as a top-level key (strings and nesting skipped, in one pass). */
const TOP_LEVEL_AGENT_ID = String.raw`BEGIN { RS = "\001" }
{
  n = length($0)
  for (i = 1; i <= n; i++) {
    c = substr($0, i, 1)
    if (instr) {
      if (esc) esc = 0
      else if (c == "\\") esc = 1
      else if (c == "\"") {
        instr = 0
        if (depth == 1 && i - start == 8 && substr($0, start, 8) == "agent_id") {
          for (j = i + 1; j <= n && substr($0, j, 1) ~ /[ \t\r\n]/; j++) {}
          if (substr($0, j, 1) == ":") found = 1
        }
      }
      continue
    }
    if (c == "\"") { instr = 1; start = i + 1 }
    else if (c == "{" || c == "[") depth++
    else if (c == "}" || c == "]") depth--
  }
}
END { exit found ? 0 : 1 }`

/**
 * The helper every hook runs with two arguments, the state (empty clears) and
 * its scope. It never fails the hook and prints `{}`: Codex requires JSON on
 * stdout from a Stop hook, and for both programs an empty object decides
 * nothing.
 */
export const HELPER_SCRIPT = String.raw`#!/bin/sh
# Bakin terminal attention: set this session's ${ATTENTION_OPTION}. Written by the terminal plugin.
input=$(cat)
printf '{}\n'
tmux=$${ATTENTION_ENV.tmux} socket=$${ATTENTION_ENV.socket} target=$${ATTENTION_ENV.target}
[ -n "$tmux" ] && [ -n "$socket" ] && [ -n "$target" ] || exit 0
# A session id, never anything tmux's command parser would read as more.
case "$target" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
case "$2" in
  main)
    case "$input" in *'"agent_id"'*)
      printf '%s' "$input" | awk '${TOP_LEVEL_AGENT_ID}' && exit 0 ;;
    esac ;;
  stale)
    "$tmux" -S "$socket" if-shell -F -t "$target" '#{m/r:^(working|needs-you)$,#{${ATTENTION_OPTION}}}' "set-option -p -t $target ${ATTENTION_OPTION} ''" >/dev/null 2>&1
    exit 0 ;;
esac
"$tmux" -S "$socket" set-option -p -t "$target" ${ATTENTION_OPTION} "$1" >/dev/null 2>&1
exit 0
`

/** Where the plugin keeps the helper and Claude Code's generated settings (never the operator's own). */
export function attentionPaths(root: string): { helper: string; claudeSettings: string } {
  const dir = join(root, 'attention')
  return { helper: join(dir, 'bakin-terminal-attention'), claudeSettings: join(dir, 'claude-settings.json') }
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const command = (helper: string, state: AttentionState | '', scope: HookScope) => `${quote(helper)} ${quote(state)} ${scope}`

/**
 * Claude Code's hooks, passed with `--settings` (they merge with the
 * operator's, project and plugin hooks — verified on 2.1.316). A permission
 * or question prompt needs you; a prompt or the main agent's tool run means it
 * is working; a finished or failed turn is your turn; a session starting or
 * ending clears. Stop never fires for an interrupted turn: the idle prompt
 * that follows (about a minute later) clears what it left — it is never
 * "needs you".
 */
export function claudeSettings(helper: string): Record<string, unknown> {
  const hook = (state: AttentionState | '', scope: HookScope, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(helper, state, scope) }] })
  return {
    hooks: {
      Notification: [hook('needs-you', 'always', 'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input'), hook('', 'stale', 'idle_prompt')],
      UserPromptSubmit: [hook('working', 'always')],
      PostToolUse: [hook('working', 'main')],
      Stop: [hook('turn-finished', 'always')],
      StopFailure: [hook('turn-finished', 'always')],
      SessionStart: [hook('', 'always')],
      SessionEnd: [hook('', 'always')],
    },
  }
}

/**
 * Codex's hooks as `-c` overrides (0.160 hooks; verified 2026-10-31). Codex
 * runs a hook only once trusted: the operator trusts these once in Codex's
 * review screen, and Codex records it. Until then the state stays unknown —
 * Bakin never bypasses hook trust. An interrupted turn clears.
 */
export function codexOverrides(helper: string): string[] {
  const events: Array<[string, AttentionState | '', HookScope]> = [
    ['PermissionRequest', 'needs-you', 'always'], ['UserPromptSubmit', 'working', 'always'], ['PostToolUse', 'working', 'main'],
    ['Stop', 'turn-finished', 'always'], ['Interrupt', '', 'always'], ['SessionStart', '', 'always'],
  ]
  return events.flatMap(([event, state, scope]) => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command(helper, state, scope))}}]}]`])
}

/** Write a file only when its contents differ (atomically), with the given mode. */
function ensureFile(path: string, contents: string, mode: number): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) { chmodSync(path, mode); return }
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, contents, { mode })
  renameSync(temporary, path)
}

/** The program's arguments and environment for attention; a shell gets none. */
export function attentionLaunch(program: Session['program'], options: { root: string; tmux: string; socket: string; sessionId: string }): { args: string[]; env: Record<string, string> } {
  if (program === 'shell') return { args: [], env: {} }
  const paths = attentionPaths(options.root)
  mkdirSync(join(options.root, 'attention'), { recursive: true, mode: 0o700 })
  ensureFile(paths.helper, HELPER_SCRIPT, 0o700)
  const env = { [ATTENTION_ENV.tmux]: options.tmux, [ATTENTION_ENV.socket]: options.socket, [ATTENTION_ENV.target]: options.sessionId }
  if (program === 'codex') return { args: codexOverrides(paths.helper), env }
  ensureFile(paths.claudeSettings, `${JSON.stringify(claudeSettings(paths.helper), null, 2)}\n`, 0o600)
  return { args: ['--settings', paths.claudeSettings], env }
}

/** Pane output within this long is "active" (spec item 5: derived activity). */
export const ACTIVE_MS = 5_000
export type Activity = 'active' | 'quiet' | 'exited'
/**
 * Derived from the program's real output — never a seed or a layout (a
 * reconnect's or resize's picture of what was already there).
 */
export function activity(session: Pick<Session, 'state'>, lastOutputAt: number | undefined, now: number): Activity {
  if (session.state !== 'running') return 'exited'
  return lastOutputAt !== undefined && now - lastOutputAt < ACTIVE_MS ? 'active' : 'quiet'
}
