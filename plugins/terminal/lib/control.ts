/**
 * A tmux control-mode client (`tmux -C`) for one session: input, resizes,
 * queries, subscriptions and hooks travel here, while terminal output stays
 * on the PTY redraw stream (the client attaches with `no-output`).
 *
 * Replies arrive in command order as `%begin`…`%end`/`%error` blocks, so a
 * FIFO of pending commands is the correlation; everything else starting with
 * `%` is a notification. The first block answers the attach itself.
 */
import { TerminalError } from './contracts'

export class ControlError extends TerminalError {
  constructor(message: string) { super(message, 503) }
}

/** Largest send-keys chunk; chunks are queued in order, so input never reorders. */
const SEND_KEYS_CHUNK = 4096
const MAX_PENDING = 256
/**
 * A reply that never comes means a wedged connection. Replies correlate by
 * order, so one cannot be skipped: the connection is closed (every waiter
 * fails, the attachment drops) and the next viewer sync reattaches.
 */
export const COMMAND_TIMEOUT_MS = 5000

export class ControlParser {
  private buffer = ''
  private block: { id: string; lines: string[] } | null = null
  constructor(private onBlock: (ok: boolean, lines: string[]) => void, private onNotification: (line: string) => void) {}
  feed(text: string): void {
    this.buffer += text
    for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
      this.line(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
    }
  }
  private line(line: string): void {
    if (this.block) {
      const end = /^%(end|error) (\S+ \S+ \S+)$/.exec(line)
      if (end && end[2] === this.block.id) {
        const { lines } = this.block
        this.block = null
        this.onBlock(end[1] === 'end', lines)
      } else this.block.lines.push(line)
      return
    }
    const begin = /^%begin (\S+ \S+ \S+)$/.exec(line)
    if (begin) this.block = { id: begin[1]!, lines: [] }
    else if (line.startsWith('%')) this.onNotification(line)
  }
}

/** One control-protocol command line: every argument double-quoted, expansions escaped. */
export function controlCommandLine(args: string[]): string {
  return args.map((arg) => {
    if (/[\n\r]/.test(arg)) throw new ControlError('Terminal control arguments cannot contain line breaks')
    return `"${arg.replace(/[\\"$]/g, (char) => `\\${char}`)}"`
  }).join(' ')
}

export interface ControlTransport {
  write(line: string): void
  close(): void
  exited: Promise<number>
}

export class ControlClient {
  private pending: Array<{ resolve: (lines: string[]) => void; reject: (error: Error) => void }> = []
  private closed = false
  private parser: ControlParser
  /** Settles when tmux has answered the attach. */
  readonly ready: Promise<void>
  /** The `tmux -C` process, so its tmux client is known as Bakin's own. */
  pid?: number
  constructor(private transport: ControlTransport, onNotification: (line: string) => void, private timeoutMs = COMMAND_TIMEOUT_MS) {
    this.parser = new ControlParser((ok, lines) => {
      const next = this.pending.shift()
      if (!next) return
      if (ok) next.resolve(lines)
      else next.reject(new ControlError(lines.join('\n') || 'Terminal command failed'))
    }, onNotification)
    this.ready = new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve: () => resolve(), reject })
    })
    // An unawaited ready must not become an unhandled rejection on exit.
    this.ready.catch(() => undefined)
    void transport.exited.then(() => this.fail())
  }
  /** Spawn `tmux -C attach` for `session` on the private socket. */
  static attach(tmux: string, socket: string, session: string, env: Record<string, string>, onNotification: (line: string) => void): ControlClient {
    const child = Bun.spawn([tmux, '-S', socket, '-C', 'attach-session', '-f', 'ignore-size,no-output', '-t', session], {
      env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    })
    const client = new ControlClient({
      write: (line) => { child.stdin.write(line); void child.stdin.flush() },
      close: () => { child.kill() },
      exited: child.exited,
    }, onNotification)
    client.pid = child.pid
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) client.feed(decoder.decode(chunk, { stream: true }))
    })()
    return client
  }
  feed(text: string): void { this.parser.feed(text) }
  command(args: string[]): Promise<string[]> {
    if (this.closed) return Promise.reject(new ControlError('Terminal control connection closed'))
    if (this.pending.length >= MAX_PENDING) return Promise.reject(new ControlError('Terminal control queue is full'))
    const line = controlCommandLine(args)
    const reply = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.timeoutMs)
      this.pending.push({ resolve: (lines) => { clearTimeout(timer); resolve(lines) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    })
    this.transport.write(`${line}\n`)
    return reply
  }
  /** Deliver bytes to a pane exactly (send-keys -H bypasses key tables). */
  async sendKeys(target: string, data: Uint8Array): Promise<void> {
    const replies: Promise<string[]>[] = []
    for (let offset = 0; offset < data.length; offset += SEND_KEYS_CHUNK) {
      const hex = Array.from(data.subarray(offset, offset + SEND_KEYS_CHUNK), (byte) => byte.toString(16).padStart(2, '0'))
      replies.push(this.command(['send-keys', '-t', target, '-H', ...hex]))
    }
    await Promise.all(replies)
  }
  close(): void {
    this.transport.close()
    this.fail()
  }
  get isClosed(): boolean { return this.closed }
  private fail(): void {
    if (this.closed) return
    this.closed = true
    const error = new ControlError('Terminal control connection closed')
    for (const entry of this.pending.splice(0)) entry.reject(error)
  }
}
