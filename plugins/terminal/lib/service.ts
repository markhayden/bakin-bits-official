import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TerminalError } from './contracts'

/** The service and shells receive no Bakin-injected provider credentials. */
export function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  env.PATH = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':')
  return env
}

export class TerminalService {
  readonly socket: string
  readonly label: string
  private readonly plist: string
  readonly tmux: string | null
  constructor(readonly root: string) {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
    const socketRoot = `/tmp/bakin-terminal-${process.getuid?.() ?? 0}-${hash}`
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 })
    chmodSync(socketRoot, 0o700)
    this.socket = join(socketRoot, 'tmux.sock')
    this.label = `io.bakin.terminal.${hash}`
    this.plist = join(homedir(), 'Library/LaunchAgents', `${this.label}.plist`)
    this.tmux = Bun.which('tmux', { PATH: terminalEnvironment().PATH })
  }
  async command(args: string[], optional = false): Promise<string> {
    if (!this.tmux) throw new TerminalError('tmux is not installed. Install tmux before setting up Terminal.', 503)
    const child = Bun.spawn([this.tmux, '-S', this.socket, ...args], { env: terminalEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 5000 })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    if (await child.exited && !optional) throw new TerminalError(error.trim() || 'Terminal service command failed', 503)
    return output
  }
  async ready(): Promise<boolean> {
    if (!this.tmux) return false
    try { await this.command(['show-options', '-g']); return true } catch { return false }
  }
  async install(): Promise<void> {
    if (process.platform !== 'darwin') throw new TerminalError('Persistent Terminal service currently requires macOS.', 503)
    if (!this.tmux) throw new TerminalError('Install tmux with Homebrew before setting up Terminal.', 503)
    if (await this.ready()) return
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true })
    const env = terminalEnvironment()
    const config = join(this.root, 'tmux.conf')
    writeFileSync(config, 'set -g exit-empty off\nset -g status off\nset -g remain-on-exit on\nset -g history-limit 2000\nset -g prefix None\nset -g mouse off\nset -g default-terminal xterm-256color\n', { mode: 0o600 })
    writeFileSync(this.plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>Label</key><string>${this.label}</string><key>ProgramArguments</key><array>${[this.tmux, '-D', '-S', this.socket, '-f', config].map((part) => `<string>${escape(part)}</string>`).join('')}</array>
      <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
      <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${escape(value)}</string>`).join('')}</dict>
      </dict></plist>`, { mode: 0o600 })
    const result = Bun.spawn(['launchctl', 'bootstrap', `gui/${process.getuid!()}`, this.plist], { stdout: 'ignore', stderr: 'pipe' })
    if (await result.exited) throw new TerminalError('Could not bootstrap the Terminal LaunchAgent', 503)
    for (let i = 0; i < 40; i++) {
      if (await this.ready()) return
      await Bun.sleep(50)
    }
    throw new TerminalError('Terminal service did not become ready', 503)
  }
  async uninstall(): Promise<void> {
    if (!existsSync(this.plist)) return
    const result = Bun.spawn(['launchctl', 'bootout', `gui/${process.getuid!()}/${this.label}`], { stdout: 'ignore', stderr: 'ignore' })
    if (await result.exited) throw new TerminalError('Could not stop the Terminal service; removal was aborted')
    unlinkSync(this.plist)
  }
}
