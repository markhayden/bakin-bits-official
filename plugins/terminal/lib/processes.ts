import type { Session } from './contracts'
import { TerminalError } from './contracts'
import { ControlClient } from './control'
import { TerminalService, terminalEnvironment } from './service'

export interface ProcessDriver {
  create(session: Session): Promise<void>
  attach(session: Session, output: (data: Uint8Array) => void): void
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
}

/**
 * The hybrid bridge per session: a PTY `attach-session` client whose redraw
 * stream is the output (and the reattach-recovery path), plus a control-mode
 * client for input, resizes and queries. Both attach `ignore-size`: only
 * Bakin's explicit `resize-window` sizes a session (window-size manual).
 */
export class TmuxProcesses implements ProcessDriver {
  private clients = new Map<string, ReturnType<typeof Bun.spawn>>()
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
  attach(session: Session, output: (data: Uint8Array) => void): void {
    if (this.clients.has(session.id)) return
    const process = Bun.spawn([this.service.tmux!, '-S', this.service.socket, 'attach-session', '-f', 'ignore-size', '-t', session.id], {
      env: terminalEnvironment(),
      terminal: { cols: session.cols, rows: session.rows, data: (_terminal, data) => output(data) },
      stderr: 'ignore',
    })
    this.clients.set(session.id, process)
    void process.exited.then(() => { if (this.clients.get(session.id) === process) this.clients.delete(session.id) })
    const control = ControlClient.attach(this.service.tmux!, this.service.socket, session.id, terminalEnvironment(), () => {})
    this.controls.set(session.id, control)
    void control.ready.catch(() => undefined)
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
  connected(id: string): boolean { return this.clients.has(id) && !this.controls.get(id)?.isClosed }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    const control = this.control(id)
    await control.ready
    await control.command(['resize-window', '-t', id, '-x', String(cols), '-y', String(rows)])
    this.clients.get(id)?.terminal?.resize(cols, rows)
  }
  async windowSize(id: string): Promise<{ cols: number; rows: number }> {
    const control = this.control(id)
    await control.ready
    const [line] = await control.command(['display-message', '-p', '-t', id, '#{window_width} #{window_height}'])
    const [cols, rows] = (line ?? '').trim().split(' ').map(Number)
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new TerminalError('Terminal window size is unknown', 503)
    // Keep the bridge PTY on the real window so its redraw stays whole.
    this.clients.get(id)?.terminal?.resize(cols!, rows!)
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
  async detach(id?: string): Promise<void> {
    const controls = id ? [this.controls.get(id)].filter((control) => control !== undefined) : [...this.controls.values()]
    if (id) this.controls.delete(id); else this.controls.clear()
    for (const control of controls) control.close()
    const clients = id ? [this.clients.get(id)].filter((client) => client !== undefined) : [...this.clients.values()]
    if (id) this.clients.delete(id); else this.clients.clear()
    for (const client of clients) { client.kill(); client.terminal?.close() }
    for (const client of clients) await client.exited
  }
}
