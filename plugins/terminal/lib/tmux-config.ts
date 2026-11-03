import { createHash } from 'node:crypto'

/**
 * The private tmux server's configuration — the ONE source; setup writes it
 * and the service fingerprint hashes it. The running daemon is never patched
 * piecemeal: a change here surfaces as "Terminal service update available"
 * and applies through a drained Set up service.
 */
export function tmuxConfig(): string {
  return `${BODY}set -g @bakin_config ${CONFIG_STAMP}\n`
}

const BODY = [
    // Sessions outlive their programs and their clients; Bakin owns cleanup.
    'set -g exit-empty off',
    'set -g remain-on-exit on',
    'set -g history-limit 50000',
    // Only Bakin's explicit resize-window sizes a window; attaching clients
    // (Bakin's control client, terminal apps) never do.
    'set -g window-size manual',
    'set -g status off',
    'set -g mouse off',
    'set -g default-terminal xterm-256color',
    'set -g allow-passthrough off',
    // A clear erases the screen, as xterm's does: no copy of it pushed into
    // tmux's history that the browser's replica never has (spec D13).
    'set -g scroll-on-clear off',
    // Native clients (Ghostty and friends): modern keys, OSC 52, titles.
    'set -g extended-keys on',
    "set -as terminal-features 'xterm-ghostty:hyperlinks:extkeys'",
    'set -g set-clipboard on',
    'set -g set-titles on',
    "set -g set-titles-string 'Bakin · #{@bakin_title}'",
    // A terminal app that sizes a session is followed: this hook marks every
    // client resize (attach included) on the session, and Bakin's control
    // client subscribes to the mark, then reads list-clients.
    "set-hook -g client-resized 'set-option -F @bakin_client \"#{client_pid} #{client_width}x#{client_height}\"'",
    // Browser input arrives through send-keys and never meets a key table;
    // this minimal prefix table is for native clients only. Nothing here can
    // add a pane or window: one pane per session is a Bakin invariant.
    'set -g prefix C-b',
    'unbind-key -a -T prefix',
    'bind-key -T prefix d detach-client',
    'bind-key -T prefix C-b send-prefix',
    'bind-key -T prefix [ copy-mode',
    'bind-key -T prefix ] paste-buffer -p',
    'bind-key -T prefix ? list-keys -N -T prefix',
    '',
  ].join('\n')

/** The body's hash, set as `@bakin_config`: a running server reporting it loaded this configuration. */
export const CONFIG_STAMP = createHash('sha256').update(BODY).digest('hex').slice(0, 16)

/**
 * What a server that loaded this configuration reports (`show-options -gv
 * <name>`): setup records its fingerprint only once these all match.
 */
export const VERIFIED_OPTIONS: Readonly<Record<string, string>> = { '@bakin_config': CONFIG_STAMP, 'scroll-on-clear': 'off' }
