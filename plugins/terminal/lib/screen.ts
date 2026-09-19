import headless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

export class Screen {
  private terminal: InstanceType<typeof headless.Terminal>
  private serializer = new SerializeAddon()
  private pending: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private overflow = false
  get failed(): boolean { return this.overflow }
  constructor(cols: number, rows: number) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    this.terminal.loadAddon(this.serializer)
  }
  write(data: Uint8Array, parsed?: () => void): Promise<void> {
    if (this.overflow || this.queuedBytes + data.byteLength > 1024 * 1024) {
      this.overflow = true
      return Promise.reject(new Error('Terminal renderer output limit exceeded; reconnect required'))
    }
    this.queuedBytes += data.byteLength
    this.pending = this.pending.then(() => new Promise<void>((resolve, reject) => this.terminal.write(data, () => {
      this.queuedBytes -= data.byteLength
      try { parsed?.(); resolve() }
      catch (error) { this.overflow = true; reject(error) }
    })))
    return this.pending
  }
  snapshot(): Promise<string> { return this.capture(() => this.serializer.serialize()) }
  capture<T>(read: () => T): Promise<T> {
    const result = this.pending.then(() => {
      if (this.overflow) throw new Error('Terminal renderer output limit exceeded; reconnect required')
      return read()
    })
    this.pending = result.then(() => {}, () => {})
    return result
  }
  serialize(): string { return this.serializer.serialize() }
  text(): string {
    const buffer = this.terminal.buffer.active
    return Array.from({ length: this.terminal.rows }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
  }
  async drain(): Promise<void> {
    // Failed writes remain visible through failed/capture; disposal still must settle.
    await this.pending.catch(() => undefined)
  }
  resize(cols: number, rows: number): void { this.terminal.resize(cols, rows) }
  close(): void { this.terminal.dispose() }
}
