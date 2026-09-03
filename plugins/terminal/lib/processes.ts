import type { Session } from './contracts'
import { TerminalError } from './contracts'
import { TerminalService, terminalEnvironment } from './service'

export interface ProcessDriver {
  create(session: Session): Promise<void>
  attach(session: Session, output: (data: Uint8Array) => void): void
  connected(id: string): boolean
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): Promise<void>
  alive(id: string): Promise<boolean>
  screen(id: string): Promise<string>
  terminate(id: string): Promise<void>
  inUse(path: string): Promise<boolean>
  detach(id?: string): Promise<void>
}

export class TmuxProcesses implements ProcessDriver {
  private clients = new Map<string, ReturnType<typeof Bun.spawn>>()
  constructor(private service: TerminalService) {}
  async create(session: Session): Promise<void> {
    if (!await this.service.ready()) throw new TerminalError('Terminal service needs setup', 503)
    const env = terminalEnvironment()
    const executable = session.program === 'shell' ? env.SHELL || '/bin/zsh' : Bun.which(session.program, { PATH: env.PATH })
    if (!executable) throw new TerminalError(`${session.program} is not installed`, 503)
    await this.service.command(['new-session', '-d', '-s', session.id, '-x', String(session.cols), '-y', String(session.rows), '-c', session.cwd,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), executable, ...(session.program === 'shell' ? ['-l'] : [])])
  }
  attach(session: Session, output: (data: Uint8Array) => void): void {
    if (this.clients.has(session.id)) return
    const process = Bun.spawn([this.service.tmux!, '-S', this.service.socket, 'attach-session', '-t', session.id], {
      env: terminalEnvironment(),
      terminal: { cols: session.cols, rows: session.rows, data: (_terminal, data) => output(data) },
      stderr: 'ignore',
    })
    this.clients.set(session.id, process)
    void process.exited.then(() => { if (this.clients.get(session.id) === process) this.clients.delete(session.id) })
  }
  write(id: string, data: string): void {
    const client = this.clients.get(id)
    if (!client?.terminal) throw new TerminalError('Terminal attachment is disconnected', 503)
    if (client.terminal.write(data) !== Buffer.byteLength(data)) throw new TerminalError('Terminal input was only partially delivered; do not retry this input')
  }
  connected(id: string): boolean { return this.clients.has(id) }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    this.clients.get(id)?.terminal?.resize(cols, rows)
    await this.service.command(['resize-window', '-t', id, '-x', String(cols), '-y', String(rows)])
  }
  async alive(id: string): Promise<boolean> {
    if (!await this.service.ready()) throw new TerminalError('Terminal service unavailable; process state is unknown', 503)
    const output = await this.service.command(['list-panes', '-a', '-F', '#{session_name} #{pane_dead}'])
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
    const clients = id ? [this.clients.get(id)].filter((client) => client !== undefined) : [...this.clients.values()]
    if (id) this.clients.delete(id); else this.clients.clear()
    for (const client of clients) { client.kill(); client.terminal?.close() }
    for (const client of clients) await client.exited
  }
}
