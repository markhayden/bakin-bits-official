/**
 * The private tmux server's configuration — the ONE source; setup writes it
 * and the service fingerprint hashes it. The running daemon is never patched
 * piecemeal: a change here surfaces as "Terminal service update available"
 * and applies through a drained Set up service.
 */
export function tmuxConfig(): string {
  return [
    // Sessions outlive their programs and their clients; Bakin owns cleanup.
    'set -g exit-empty off',
    'set -g remain-on-exit on',
    'set -g history-limit 50000',
    'set -g status off',
    'set -g mouse off',
    'set -g default-terminal xterm-256color',
    'set -g allow-passthrough off',
    // Native clients (Ghostty and friends): modern keys, OSC 52, titles.
    'set -g extended-keys on',
    "set -as terminal-features 'xterm-ghostty:hyperlinks:extkeys'",
    'set -g set-clipboard on',
    'set -g set-titles on',
    "set -g set-titles-string 'Bakin · #{@bakin_title}'",
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
}
