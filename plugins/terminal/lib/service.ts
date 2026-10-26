import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import manifest from '../bakin-plugin.json'
import { TerminalError } from './contracts'
import { tmuxConfig } from './tmux-config'

const bakinHome = () => process.env.BAKIN_HOME || join(homedir(), '.bakin')

/** The managed tmux pin this plugin declares for the current platform. */
function tmuxPin(): { version: string; sha256: string } {
  const bin = manifest.requires.bins.find((entry) => entry.name === 'tmux')!
  const install = (bin.install as Record<string, { archive?: { extractedSha256?: string } } | undefined>)[`${process.platform}-${process.arch}`]
  return { version: bin.version, sha256: install?.archive?.extractedSha256 ?? 'unsupported-platform' }
}

/** The service and shells receive no Bakin-injected provider credentials. */
export function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  env.PATH = [join(bakinHome(), 'bin'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':')
  return env
}

export class TerminalService {
  readonly socket: string
  readonly label: string
  private readonly plist: string
  private readonly record: string
  private setup: Promise<void> | undefined
  private pending = new Set<Promise<string>>()
  /** Only Bakin's managed, pinned tmux — never a PATH lookup. */
  get tmux(): string | null {
    const path = join(bakinHome(), 'bin', 'tmux')
    return existsSync(path) ? path : null
  }
  constructor(readonly root: string) {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
    const socketRoot = `/tmp/bakin-terminal-${process.getuid?.() ?? 0}-${hash}`
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 })
    chmodSync(socketRoot, 0o700)
    this.socket = join(socketRoot, 'tmux.sock')
    this.label = `io.bakin.terminal.${hash}`
    this.plist = join(homedir(), 'Library/LaunchAgents', `${this.label}.plist`)
    this.record = join(root, 'service.json')
  }
  /**
   * What the running service must be: the pinned tmux identity, the
   * generated config and the program arguments. Incidental environment (PATH
   * order, locale) is deliberately excluded so it never forces a drain.
   */
  private fingerprint(tmux: string): string {
    const pin = tmuxPin()
    return createHash('sha256').update(JSON.stringify({ tmux, version: pin.version, sha256: pin.sha256, config: tmuxConfig(), args: this.programArguments(tmux) })).digest('hex')
  }
  private programArguments(tmux: string): string[] {
    return [tmux, '-D', '-S', this.socket, '-f', join(this.root, 'tmux.conf')]
  }
  private recordedFingerprint(): string | undefined {
    if (!existsSync(this.record)) return undefined
    try {
      const value = (JSON.parse(readFileSync(this.record, 'utf8')) as { fingerprint?: unknown }).fingerprint
      return typeof value === 'string' ? value : undefined
    } catch {
      // An unreadable record is no evidence the service is current.
      return undefined
    }
  }
  async command(args: string[], optional = false): Promise<string> {
    if (this.setup) throw new TerminalError('Terminal service setup is in progress; try again after it finishes.', 503)
    const operation = this.execute(args, optional)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }
  private async execute(args: string[], optional = false): Promise<string> {
    const tmux = this.tmux
    if (!tmux) throw new TerminalError('Terminal needs tmux. Open Health and run the plugin assets repair, or run bakin install plugin-assets.', 503)
    const child = Bun.spawn([tmux, '-S', this.socket, ...args], { env: terminalEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 5000 })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    if (await child.exited && !optional) throw new TerminalError(error.trim() || 'Terminal service command failed', 503)
    return output
  }
  async ready(): Promise<boolean> {
    if (!this.tmux) return false
    try { await this.execute(['show-options', '-g']); return true } catch { return false }
  }
  private async installedProgram(): Promise<string | undefined> {
    if (!existsSync(this.plist)) return undefined
    const result = Bun.spawn(['/usr/bin/plutil', '-extract', 'ProgramArguments.0', 'raw', '-o', '-', this.plist], { stdout: 'pipe', stderr: 'pipe' })
    const path = (await new Response(result.stdout).text()).trim()
    if (await result.exited || !path) throw new TerminalError('Could not read the Terminal service configuration; no changes were made.', 503)
    return path
  }
  /**
   * True when a service is installed but was not verifiably started as the
   * desired one (other binary, other config, or no recorded fingerprint).
   */
  async updateRequired(): Promise<boolean> {
    const tmux = this.tmux
    if (!tmux || !await this.installedProgram()) return false
    return this.recordedFingerprint() !== this.fingerprint(tmux)
  }
  install(): Promise<void> {
    if (!this.setup) {
      this.setup = this.installService().finally(() => { this.setup = undefined })
    }
    return this.setup
  }
  private async installService(): Promise<void> {
    // Drain commands already sent, and reject new commands throughout setup.
    await Promise.allSettled([...this.pending])
    if (process.platform !== 'darwin') throw new TerminalError('Persistent Terminal service currently requires macOS.', 503)
    const tmux = this.tmux
    if (!tmux) throw new TerminalError('Terminal needs tmux. Open Health and run the plugin assets repair, or run bakin install plugin-assets.', 503)
    const program = await this.installedProgram()
    const ready = await this.ready()
    const desired = this.fingerprint(tmux)
    if (ready && program && this.recordedFingerprint() === desired) return
    if (ready) {
      // An empty persistent server reports "no current target" from list-panes.
      // Count all live panes, including sessions not recorded by the plugin.
      const names = await this.execute(['list-sessions', '-F', '#{session_name}'])
      const panes = names.trim() ? await this.execute(['list-panes', '-a', '-F', '#{session_name} #{pane_dead}']) : ''
      const states = panes.trim() ? panes.trim().split('\n').map(line => line.split(' ')) : []
      if ((names.trim() && !states.length) || states.some(([, dead]) => dead !== '0' && dead !== '1')) throw new TerminalError('Terminal process state is unknown; no changes were made.', 503)
      const live = [...new Set(states.filter(([, dead]) => dead === '0').map(([name]) => name!))]
      if (live.length) throw new TerminalError(`Terminal still has ${live.length} live terminal session${live.length === 1 ? '' : 's'} (${live.join(', ')}). End them and press Set up service again to apply the Terminal service update.`, 409)
      const stopped = Bun.spawn(['launchctl', 'bootout', `gui/${process.getuid!()}/${this.label}`], { stdout: 'ignore', stderr: 'ignore' })
      if (await stopped.exited) throw new TerminalError('Could not stop the old Terminal service; no configuration was changed.', 503)
    } else if (program) {
      const job = Bun.spawn(['launchctl', 'print', `gui/${process.getuid!()}/${this.label}`], { stdout: 'ignore', stderr: 'ignore' })
      if (await job.exited !== 113) throw new TerminalError('Terminal process state is unknown. Its service is still registered; no changes were made.', 503)
    }
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true })
    const env = terminalEnvironment()
    // Any previous record is void the moment the service is replaced.
    if (existsSync(this.record)) unlinkSync(this.record)
    writeFileSync(join(this.root, 'tmux.conf'), tmuxConfig(), { mode: 0o600 })
    writeFileSync(this.plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>Label</key><string>${this.label}</string><key>ProgramArguments</key><array>${this.programArguments(tmux).map((part) => `<string>${escape(part)}</string>`).join('')}</array>
      <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
      <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${escape(value)}</string>`).join('')}</dict>
      </dict></plist>`, { mode: 0o600 })
    const result = Bun.spawn(['launchctl', 'bootstrap', `gui/${process.getuid!()}`, this.plist], { stdout: 'ignore', stderr: 'pipe' })
    if (await result.exited) throw new TerminalError('Could not bootstrap the Terminal LaunchAgent', 503)
    for (let i = 0; i < 40; i++) {
      if (await this.ready()) {
        // Recorded only now: a file on disk is not proof the daemon runs it.
        writeFileSync(this.record, JSON.stringify({ fingerprint: desired, verifiedAt: new Date().toISOString() }), { mode: 0o600 })
        return
      }
      await Bun.sleep(50)
    }
    throw new TerminalError('Terminal service did not become ready', 503)
  }
  async uninstall(): Promise<void> {
    if (!existsSync(this.plist)) return
    const result = Bun.spawn(['launchctl', 'bootout', `gui/${process.getuid!()}/${this.label}`], { stdout: 'ignore', stderr: 'ignore' })
    if (await result.exited) throw new TerminalError('Could not stop the Terminal service; removal was aborted')
    unlinkSync(this.plist)
    if (existsSync(this.record)) unlinkSync(this.record)
  }
}
