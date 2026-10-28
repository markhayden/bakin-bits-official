import headless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { cursorVisibilitySequence, trackCursorVisibility } from './cursor-visibility'
import { patchEraseAbove } from './xterm-fixes'

export class Screen {
  private terminal: InstanceType<typeof headless.Terminal>
  private serializer = new SerializeAddon()
  private pending: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private overflow = false
  get failed(): boolean { return this.overflow }
  // SerializeAddon leaves DECTCEM out: a joining screen must know whether the
  // program hid its cursor (Claude Code does; the viewer then never follows it sideways).
  private cursor: ReturnType<typeof trackCursorVisibility>
  constructor(cols: number, rows: number) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    this.terminal.loadAddon(this.serializer)
    this.cursor = trackCursorVisibility(this.terminal)
    patchEraseAbove(this.terminal)
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
  snapshot(): Promise<string> { return this.capture(() => this.serialize()) }
  capture<T>(read: () => T): Promise<T> {
    const result = this.pending.then(() => {
      if (this.overflow) throw new Error('Terminal renderer output limit exceeded; reconnect required')
      return read()
    })
    this.pending = result.then(() => {}, () => {})
    return result
  }
  serialize(): string { return this.serializer.serialize() + cursorVisibilitySequence(this.cursor.hidden) }
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
