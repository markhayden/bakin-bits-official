import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { CONFIG_STAMP, tmuxConfig, VERIFIED_OPTIONS } from '../lib/tmux-config'

const lines = tmuxConfig().trim().split('\n')

describe('tmuxConfig', () => {
  it('keeps sessions, history and output the way Bakin relies on', () => {
    for (const line of [
      'set -g exit-empty off',
      'set -g remain-on-exit on',
      'set -g history-limit 50000',
      'set -g window-size manual',
      'set -g status off',
      'set -g mouse off',
      'set -g default-terminal xterm-256color',
      'set -g allow-passthrough off',
      'set -g scroll-on-clear off',
    ]) expect(lines).toContain(line)
  })

  it('ends with its stamp, the hash of everything before it, which setup verifies with scroll-on-clear', () => {
    expect(lines.at(-1)).toBe(`set -g @bakin_config ${CONFIG_STAMP}`)
    expect(VERIFIED_OPTIONS).toEqual({ '@bakin_config': CONFIG_STAMP, 'scroll-on-clear': 'off' })
    expect(CONFIG_STAMP).toBe(createHash('sha256').update(tmuxConfig().slice(0, tmuxConfig().lastIndexOf('set -g @bakin_config'))).digest('hex').slice(0, 16))
  })

  it('gives native clients modern keys, clipboard and a Bakin window title', () => {
    for (const line of [
      'set -g extended-keys on',
      "set -as terminal-features 'xterm-ghostty:hyperlinks:extkeys'",
      'set -g set-clipboard on',
      'set -g set-titles on',
      "set -g set-titles-string 'Bakin · #{@bakin_title}'",
    ]) expect(lines).toContain(line)
  })

  it('binds a minimal C-b prefix table: detach, send-prefix, copy-mode, paste, help — nothing that adds panes or windows', () => {
    expect(lines).toContain('set -g prefix C-b')
    const unbind = lines.indexOf('unbind-key -a -T prefix')
    expect(unbind).toBeGreaterThan(lines.indexOf('set -g prefix C-b'))
    const bindings = lines.filter((line) => line.startsWith('bind-key'))
    expect(bindings).toEqual([
      'bind-key -T prefix d detach-client',
      'bind-key -T prefix C-b send-prefix',
      'bind-key -T prefix [ copy-mode',
      'bind-key -T prefix ] paste-buffer -p',
      'bind-key -T prefix ? list-keys -N -T prefix',
    ])
    expect(lines.findIndex((line) => line.startsWith('bind-key'))).toBeGreaterThan(unbind)
  })

  it('is deterministic (it feeds the service fingerprint)', () => {
    expect(tmuxConfig()).toBe(tmuxConfig())
  })
})
