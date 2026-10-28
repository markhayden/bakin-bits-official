/**
 * A tmux control-mode client (`tmux -C`) for one session: input, resizes,
 * queries, subscriptions and hooks travel here, and so does the pane's
 * output (`%output`), which feeds the session's event log (spec D13).
 *
 * The stream is bytes: `%output` carries the program's raw bytes with only
 * control bytes and `\` escaped as octal, so lines are split and decoded as
 * bytes, never as text.
 *
 * Replies arrive in command order as `%begin`…`%end`/`%error` blocks. The
 * first block answers the attach itself; after it, only blocks flagged as
 * this client's (`flags` 1) answer commands. A grouped command line
 * (`a ; b`) answers with one block per command, or stops at its first
 * `%error` (tmux skips the rest of the group). Everything else starting
 * with `%` is a notification.
 */
import { TerminalError } from './contracts'

export class ControlError extends TerminalError {
  constructor(message: string) { super(message, 503) }
}

/** Largest send-keys chunk; chunks are queued in order, so input never reorders. */
const SEND_KEYS_CHUNK = 4096
const MAX_PENDING = 256
/** A line longer than this is not tmux talking: the connection is closed. */
export const MAX_CONTROL_LINE = 4 * 1024 * 1024
/**
 * A reply that never comes means a wedged connection. Replies correlate by
 * order, so one cannot be skipped: the connection is closed (every waiter
 * fails, the attachment drops) and the next viewer sync reattaches.
 */
export const COMMAND_TIMEOUT_MS = 5000

export interface ControlBlock { ok: boolean; flags: string; lines: string[] }
export interface ControlParserEvents {
  block(block: ControlBlock): void
  notification(line: string): void
  output(pane: string, bytes: Uint8Array): void
  /** A protocol violation (an over-long line): the stream cannot be trusted. */
  invalid(reason: string): void
}

const NEWLINE = 0x0a
const BACKSLASH = 0x5c
const OUTPUT = new TextEncoder().encode('%output ')
const text = new TextDecoder()
const startsWith = (line: Uint8Array, prefix: Uint8Array) => line.length >= prefix.length && prefix.every((byte, i) => line[i] === byte)

/** `%output`'s payload: octal escapes (`\ooo`) back to bytes, every other byte as it is. */
export function decodeOutput(data: Uint8Array): Uint8Array {
  if (!data.includes(BACKSLASH)) return data.slice()
  const out = new Uint8Array(data.length)
  let length = 0
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!
    if (byte === BACKSLASH && i + 3 < data.length) {
      const a = data[i + 1]! - 0x30, b = data[i + 2]! - 0x30, c = data[i + 3]! - 0x30
      if (a >= 0 && a <= 7 && b >= 0 && b <= 7 && c >= 0 && c <= 7) {
        out[length++] = (a << 6) | (b << 3) | c
        i += 3
        continue
      }
    }
    out[length++] = byte
  }
  return out.slice(0, length)
}

export class ControlParser {
  private partial: Uint8Array = new Uint8Array(0)
  private block: { id: string; flags: string; lines: string[] } | null = null
  private broken = false
  constructor(private events: ControlParserEvents) {}
  feed(chunk: Uint8Array): void {
    if (this.broken) return
    let data = chunk
    if (this.partial.length) {
      data = new Uint8Array(this.partial.length + chunk.length)
      data.set(this.partial)
      data.set(chunk, this.partial.length)
    }
    let start = 0
    for (let newline = data.indexOf(NEWLINE); newline !== -1; newline = data.indexOf(NEWLINE, start)) {
      this.line(data.subarray(start, newline))
      start = newline + 1
      if (this.broken) return
    }
    this.partial = data.slice(start)
    if (this.partial.length > MAX_CONTROL_LINE) {
      this.broken = true
      this.events.invalid('control line too long')
    }
  }
  private line(bytes: Uint8Array): void {
    if (this.block) {
      const line = text.decode(bytes)
      const end = /^%(end|error) (\S+ \S+ \S+)$/.exec(line)
      if (end && end[2] === this.block.id) {
        const { flags, lines } = this.block
        this.block = null
        this.events.block({ ok: end[1] === 'end', flags, lines })
      } else this.block.lines.push(line)
      return
    }
    if (startsWith(bytes, OUTPUT)) {
      const space = bytes.indexOf(0x20, OUTPUT.length)
      if (space === -1) return
      this.events.output(text.decode(bytes.subarray(OUTPUT.length, space)), decodeOutput(bytes.subarray(space + 1)))
      return
    }
    const line = text.decode(bytes)
    const begin = /^%begin (\S+ \S+ (\S+))$/.exec(line)
    if (begin) this.block = { id: begin[1]!, flags: begin[2]!, lines: [] }
    else if (line.startsWith('%')) this.events.notification(line)
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

export interface ControlHandlers {
  notification?(line: string): void
  /** The pane's output, in order, as the program wrote it. */
  output?(pane: string, bytes: Uint8Array): void
  /** The connection ended, once: tmux's `%exit` reason, `eof`, `timeout`, `closed` (by Bakin) or a protocol fault. */
  closed?(reason: string): void
}

interface Pending { blocks: number; replies: string[][]; resolve(replies: string[][]): void; reject(error: Error): void }

export class ControlClient {
  private pending: Pending[] = []
  private closed = false
  private attached = false
  private exitReason: string | undefined
  private parser: ControlParser
  /** Settles when tmux has answered the attach. */
  readonly ready: Promise<void>
  /** The `tmux -C` process, so its tmux client is known as Bakin's own. */
  pid?: number
  constructor(private transport: ControlTransport, private handlers: ControlHandlers = {}, private timeoutMs = COMMAND_TIMEOUT_MS) {
    this.parser = new ControlParser({
      block: (block) => this.answer(block),
      notification: (line) => {
        // `%exit` means this control client is ending, not the program (D4).
        if (line === '%exit' || line.startsWith('%exit ')) this.exitReason = line.slice(6).trim() || 'exit'
        handlers.notification?.(line)
      },
      output: (pane, bytes) => handlers.output?.(pane, bytes),
      invalid: (reason) => this.close(reason),
    })
    this.ready = new Promise<void>((resolve, reject) => {
      // The attach is answered like a command, and times out like one.
      const timer = setTimeout(() => this.close('timeout'), this.timeoutMs)
      this.pending.push({ blocks: 1, replies: [], resolve: () => { clearTimeout(timer); resolve() }, reject: (error) => { clearTimeout(timer); reject(error) } })
    })
    // An unawaited ready must not become an unhandled rejection on exit.
    this.ready.catch(() => undefined)
    void transport.exited.then(() => this.fail(this.exitReason ?? 'eof'))
  }
  /** Spawn `tmux -C attach` for `session` on the private socket. */
  static attach(tmux: string, socket: string, session: string, env: Record<string, string>, handlers: ControlHandlers): ControlClient {
    const child = Bun.spawn([tmux, '-S', socket, '-C', 'attach-session', '-f', 'ignore-size', '-t', session], {
      env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    })
    const client = new ControlClient({
      write: (line) => { child.stdin.write(line); void child.stdin.flush() },
      close: () => { child.kill() },
      exited: child.exited,
    }, handlers)
    client.pid = child.pid
    void (async () => {
      for await (const chunk of child.stdout) client.feed(chunk)
    })()
    return client
  }
  feed(chunk: Uint8Array | string): void { this.parser.feed(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk) }
  private answer(block: ControlBlock): void {
    // The first block answers the attach; after it, only this client's commands are ours.
    if (this.attached && block.flags !== '1') return
    this.attached = true
    const next = this.pending[0]
    if (!next) return
    if (!block.ok) {
      // tmux skips the rest of a group after an error.
      this.pending.shift()
      next.reject(new ControlError(block.lines.join('\n') || 'Terminal command failed'))
      return
    }
    next.replies.push(block.lines)
    if (next.replies.length < next.blocks) return
    this.pending.shift()
    next.resolve(next.replies)
  }
  private send(commands: string[][]): Promise<string[][]> {
    if (this.closed) return Promise.reject(new ControlError('Terminal control connection closed'))
    if (this.pending.length >= MAX_PENDING) return Promise.reject(new ControlError('Terminal control queue is full'))
    const line = commands.map(controlCommandLine).join(' ; ')
    const reply = new Promise<string[][]>((resolve, reject) => {
      const timer = setTimeout(() => this.close('timeout'), this.timeoutMs)
      this.pending.push({ blocks: commands.length, replies: [], resolve: (replies) => { clearTimeout(timer); resolve(replies) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    })
    this.transport.write(`${line}\n`)
    return reply
  }
  command(args: string[]): Promise<string[]> {
    return this.send([args]).then(([lines]) => lines!)
  }
  /**
   * Several commands as one line, run by tmux as one group with nothing in
   * between: one reply per command, in order. A failing command rejects the
   * whole group (tmux skips the rest).
   */
  group(commands: string[][]): Promise<string[][]> {
    if (commands.length === 0) return Promise.resolve([])
    return this.send(commands)
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
  close(reason = 'closed'): void {
    this.transport.close()
    this.fail(reason)
  }
  get isClosed(): boolean { return this.closed }
  private fail(reason: string): void {
    if (this.closed) return
    this.closed = true
    const error = new ControlError('Terminal control connection closed')
    for (const entry of this.pending.splice(0)) entry.reject(error)
    this.handlers.closed?.(reason)
  }
}
