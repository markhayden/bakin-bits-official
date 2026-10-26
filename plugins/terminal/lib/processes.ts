import type { Session } from './contracts'
import { TerminalError } from './contracts'
import { ControlClient } from './control'
import { TerminalService, terminalEnvironment } from './service'

/** A tmux client on a session that is not Bakin's own bridge or control client: a terminal app (Ghostty and friends) or anything else that attached. */
export interface NativeClient { pid: number; name: string; cols: number; rows: number; readonly: boolean }

export interface ProcessDriver {
  create(session: Session): Promise<void>
  /** `clientsChanged` fires when a tmux client attaches to, resizes on, or detaches from the session. */
  attach(session: Session, output: (data: Uint8Array) => void, clientsChanged: () => void): void
  connected(id: string): boolean
  /** Resolves once tmux has accepted the bytes for the pane (not that the program read them). */
  write(id: string, data: string): Promise<void>
  /** Set the pane title native clients show (`@bakin_title`). */
  title(session: Session): Promise<void>
  /** tmux first (resize-window), then the bridge PTY. */
  resize(id: string, cols: number, rows: number): Promise<void>
  /** The window size tmux actually has. */
  windowSize(id: string): Promise<{ cols: number; rows: number }>
  alive(id: string): Promise<boolean>
  screen(id: string): Promise<string>
  terminate(id: string): Promise<void>
  inUse(path: string): Promise<boolean>
  detach(id?: string): Promise<void>
  /** The terminal apps attached to a session. */
  clients(id: string): Promise<NativeClient[]>
  detachClient(name: string): Promise<void>
  /** Let a client type (admitted) or stop it typing (held until its reservation is confirmed). */
  setReadonly(name: string, readonly: boolean): Promise<void>
  /** tmux arguments (after the binary) that attach a terminal app to the session, read-only until admitted. */
  attachArgs(id: string): string[]
}

/** Shown inside the terminal app as it attaches (tmux status line, five seconds). */
export const ATTACH_HINT = 'Detach: Ctrl-b d · Scrollback: Ctrl-b [ · Closing the window also detaches'

/**
 * The hybrid bridge per session: a PTY `attach-session` client whose redraw
 * stream is the output (and the reattach-recovery path), plus a control-mode
 * client for input, resizes and queries. Both attach `ignore-size`: only
 * Bakin's explicit `resize-window` sizes a session (window-size manual).
 */
export class TmuxProcesses implements ProcessDriver {
  private bridges = new Map<string, ReturnType<typeof Bun.spawn>>()
  private controls = new Map<string, ControlClient>()
  constructor(private service: TerminalService) {}
  async create(session: Session): Promise<void> {
    if (!await this.service.ready()) throw new TerminalError('Terminal service needs setup', 503)
    const env = terminalEnvironment()
    const executable = session.program === 'shell' ? env.SHELL || '/bin/zsh' : Bun.which(session.program, { PATH: env.PATH })
    if (!executable) throw new TerminalError(`${session.program} is not installed`, 503)
    await this.service.command(['new-session', '-d', '-s', session.id, '-x', String(session.cols), '-y', String(session.rows), '-c', session.cwd,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), executable, ...(session.program === 'shell' ? ['-l'] : [])])
    await this.title(session)
  }
  /** Native clients title their window from this (tmux.conf set-titles-string). */
  async title(session: Session): Promise<void> {
    await this.service.command(['set-option', '-t', session.id, '@bakin_title', session.title])
  }
  attach(session: Session, output: (data: Uint8Array) => void, clientsChanged: () => void): void {
    if (this.bridges.has(session.id)) return
    const process = Bun.spawn([this.service.tmux!, '-S', this.service.socket, 'attach-session', '-f', 'ignore-size', '-t', session.id], {
      env: terminalEnvironment(),
      terminal: { cols: session.cols, rows: session.rows, data: (_terminal, data) => output(data) },
      stderr: 'ignore',
    })
    this.bridges.set(session.id, process)
    void process.exited.then(() => { if (this.bridges.get(session.id) === process) this.bridges.delete(session.id) })
    // A client attaching to this session, any client leaving, or the
    // client-resized hook (tmux.conf sets @bakin_client, which this
    // subscription watches) means the set of terminal apps may have changed.
    const control = ControlClient.attach(this.service.tmux!, this.service.socket, session.id, terminalEnvironment(), (line) => {
      const [kind, , , name] = line.split(' ')
      if ((kind === '%client-session-changed' && name === session.id) || kind === '%client-detached' || line.startsWith('%subscription-changed bakin-client ')) clientsChanged()
    })
    this.controls.set(session.id, control)
    void control.ready.then(() => control.command(['refresh-client', '-B', 'bakin-client::#{@bakin_client}'])).catch(() => undefined)
  }
  private control(id: string): ControlClient {
    const control = this.controls.get(id)
    if (!control || control.isClosed) throw new TerminalError('Terminal attachment is disconnected', 503)
    return control
  }
  async write(id: string, data: string): Promise<void> {
    const control = this.control(id)
    await control.ready
    // Browser and agent input always reaches the program: a native client's
    // scrollback (copy mode) is cancelled first. Each step is its own awaited
    // command — a command that runs another (if-shell) emits extra reply
    // blocks and would break the control client's FIFO correlation.
    const [mode] = await control.command(['display-message', '-p', '-t', id, '#{pane_in_mode}'])
    if (mode?.trim() === '1') await control.command(['send-keys', '-X', '-t', id, 'cancel'])
    await control.sendKeys(id, new TextEncoder().encode(data))
  }
  connected(id: string): boolean { return this.bridges.has(id) && !this.controls.get(id)?.isClosed }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    const control = this.control(id)
    await control.ready
    await control.command(['resize-window', '-t', id, '-x', String(cols), '-y', String(rows)])
    this.bridges.get(id)?.terminal?.resize(cols, rows)
  }
  async windowSize(id: string): Promise<{ cols: number; rows: number }> {
    const control = this.control(id)
    await control.ready
    const [line] = await control.command(['display-message', '-p', '-t', id, '#{window_width} #{window_height}'])
    const [cols, rows] = (line ?? '').trim().split(' ').map(Number)
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new TerminalError('Terminal window size is unknown', 503)
    // Keep the bridge PTY on the real window so its redraw stays whole.
    this.bridges.get(id)?.terminal?.resize(cols!, rows!)
    return { cols: cols!, rows: rows! }
  }
  async alive(id: string): Promise<boolean> {
    if (!await this.service.ready()) throw new TerminalError('Terminal service unavailable; process state is unknown', 503)
    // tmux `list-panes -a` exits non-zero with "no current target" when the
    // persistent server is running but has no sessions. Treat that as an empty
    // pane list so activation/recovery can mark stale running rows as exited.
    const output = await this.service.command(['list-panes', '-a', '-F', '#{session_name} #{pane_dead}'], true)
    return output.split('\n').includes(`${id} 0`)
  }
  async screen(id: string): Promise<string> {
    return this.service.command(['capture-pane', '-p', '-t', id])
  }
  async terminate(id: string): Promise<void> {
    const names = await this.service.command(['list-sessions', '-F', '#{session_name}'])
    if (names.split('\n').includes(id)) await this.service.command(['kill-session', '-t', id])
  }
  async inUse(path: string): Promise<boolean> {
    const executable = Bun.which('lsof')
    if (!executable) return true
    const child = Bun.spawn([executable, '-t', '+D', path], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    const exit = await child.exited
    return Boolean(output.trim() || error.trim()) || (exit !== 0 && exit !== 1)
  }
  async clients(id: string): Promise<NativeClient[]> {
    // Bakin's own clients by process, never by kind: a foreign control-mode client is just another client.
    const own = new Set([this.bridges.get(id)?.pid, this.controls.get(id)?.pid])
    const output = await this.service.command(['list-clients', '-t', id, '-F', '#{client_pid} #{client_readonly} #{client_width} #{client_height} #{client_name}'])
    return output.split('\n').flatMap((line) => {
      const [pid, readonly, cols, rows, ...name] = line.split(' ')
      return line && !own.has(Number(pid)) ? [{ pid: Number(pid), name: name.join(' '), cols: Number(cols), rows: Number(rows), readonly: readonly === '1' }] : []
    })
  }
  async detachClient(name: string): Promise<void> {
    await this.service.command(['detach-client', '-t', name])
  }
  async setReadonly(name: string, readonly: boolean): Promise<void> {
    // switch-client -r toggles; only toggle a client that is the other way.
    const [line] = (await this.service.command(['display-message', '-p', '-c', name, '#{client_readonly}'])).split('\n')
    if ((line?.trim() === '1') !== readonly) await this.service.command(['switch-client', '-c', name, '-r'])
  }
  attachArgs(id: string): string[] {
    return ['-S', this.service.socket, 'attach-session', '-f', 'read-only', '-t', id, ';', 'display-message', '-d', '5000', ATTACH_HINT]
  }
  async detach(id?: string): Promise<void> {
    const controls = id ? [this.controls.get(id)].filter((control) => control !== undefined) : [...this.controls.values()]
    if (id) this.controls.delete(id); else this.controls.clear()
    for (const control of controls) control.close()
    const clients = id ? [this.bridges.get(id)].filter((client) => client !== undefined) : [...this.bridges.values()]
    if (id) this.bridges.delete(id); else this.bridges.clear()
    for (const client of clients) { client.kill(); client.terminal?.close() }
    for (const client of clients) await client.exited
  }
}
