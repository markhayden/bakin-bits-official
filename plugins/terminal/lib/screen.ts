import headless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { cursorVisibilitySequence, trackCursorVisibility } from './cursor-visibility'
import { applyTerminalProfile, TERMINAL_OPTIONS } from './terminal-profile'
import { guardParser } from './xterm-fixes'

export class Screen {
  private terminal: InstanceType<typeof headless.Terminal>
  private serializer = new SerializeAddon()
  private pending: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private overflow = false
  private parser: { readonly failed: boolean }
  get failed(): boolean { return this.overflow || this.parser.failed }
  // SerializeAddon leaves DECTCEM out: a joining screen must know whether the
  // program hid its cursor (Claude Code does; the viewer then never follows it sideways).
  private cursor: ReturnType<typeof trackCursorVisibility>
  constructor(cols: number, rows: number) {
    this.terminal = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
    this.terminal.loadAddon(this.serializer)
    this.cursor = trackCursorVisibility(this.terminal)
    // The shared profile (spec D13): one parse for the server and every viewer.
    applyTerminalProfile(this.terminal)
    // A parser exception fails this screen (a reconnect rebuilds it) instead of wedging every later write.
    this.parser = guardParser(this.terminal, () => { this.overflow = true })
  }
  write(data: Uint8Array, parsed?: () => void): Promise<void> {
    if (this.failed || this.queuedBytes + data.byteLength > 1024 * 1024) {
      this.overflow = true
      return Promise.reject(new Error('Terminal renderer output limit exceeded; reconnect required'))
    }
    this.queuedBytes += data.byteLength
    // Every settlement path releases this write's charge exactly once.
    const run = () => new Promise<void>((resolve, reject) => {
      let charged = true
      const release = () => { if (charged) { charged = false; this.queuedBytes -= data.byteLength } }
      const failed = () => new Error('Terminal renderer failed; reconnect required')
      if (this.failed) { release(); reject(failed()); return }
      try {
        this.terminal.write(data, () => {
          release()
          if (this.parser.failed) { reject(failed()); return }
          try { parsed?.(); resolve() }
          catch (error) { this.overflow = true; reject(error) }
        })
      } catch (error) {
        // A synchronous submission failure fails the screen like a parser one.
        release()
        this.overflow = true
        reject(error)
      }
    })
    // Run after the previous write whether it succeeded or not.
    this.pending = this.pending.then(run, run)
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
