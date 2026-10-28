import headless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { cursorVisibilitySequence, trackCursorVisibility } from './cursor-visibility'
import { terminalBytes } from './memory'
import { screenView, type ScreenView } from './shadow'
import { applyTerminalProfile, TERMINAL_OPTIONS } from './terminal-profile'
import { guardParser } from './xterm-fixes'

interface Pending { data: Uint8Array; parsed?: () => void; resolve(): void; reject(error: unknown): void }

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) { all.set(part, at); at += part.byteLength }
  return all
}

export class Screen {
  private terminal: InstanceType<typeof headless.Terminal>
  private serializer = new SerializeAddon()
  private pending: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  /** The batch still accepting writes (not started, no capture queued after it). */
  private open: Pending[] | undefined
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
  /**
   * Queue `data` for the parser; `parsed` runs once it is on the screen. Writes
   * queued while the parser is busy are coalesced into one xterm write (each
   * xterm write costs a timer turn, so small PTY chunks one at a time capped a
   * busy session at a few KB/s). A batch takes writes only until it starts or a
   * capture is queued, so a capture sees exactly the writes before it.
   */
  write(data: Uint8Array, parsed?: () => void): Promise<void> {
    if (this.failed || this.queuedBytes + data.byteLength > 1024 * 1024) {
      this.overflow = true
      return Promise.reject(new Error('Terminal renderer output limit exceeded; reconnect required'))
    }
    this.queuedBytes += data.byteLength
    let batch = this.open
    if (!batch) {
      const entries: Pending[] = []
      batch = entries
      this.open = entries
      const run = () => this.runBatch(entries)
      // Run after the previous batch or capture, whether it succeeded or not.
      this.pending = this.pending.then(run, run)
      // A failed batch is reported through its writes' own promises.
      this.pending.catch(() => undefined)
    }
    return new Promise<void>((resolve, reject) => { batch.push({ data, parsed, resolve, reject }) })
  }
  private runBatch(entries: Pending[]): Promise<void> {
    if (this.open === entries) this.open = undefined
    return new Promise<void>((done) => {
      // Every settlement path releases each write's charge exactly once.
      const settle = (from: number, error?: unknown) => {
        for (let i = from; i < entries.length; i++) {
          const entry = entries[i]!
          this.queuedBytes -= entry.data.byteLength
          if (error === undefined) entry.resolve()
          else entry.reject(error)
        }
        done()
      }
      const failed = () => new Error('Terminal renderer failed; reconnect required')
      if (this.failed) { settle(0, failed()); return }
      const data = entries.length === 1 ? entries[0]!.data : concat(entries.map((entry) => entry.data))
      try {
        this.terminal.write(data, () => {
          if (this.parser.failed) { settle(0, failed()); return }
          // In order: each write's callback, then its promise.
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!
            try { entry.parsed?.() } catch (error) {
              this.overflow = true
              settle(i, error)
              return
            }
            this.queuedBytes -= entry.data.byteLength
            entry.resolve()
          }
          done()
        })
      } catch (error) {
        // A synchronous submission failure fails the screen like a parser one.
        this.overflow = true
        settle(0, error)
      }
    })
  }
  snapshot(): Promise<string> { return this.capture(() => this.serialize()) }
  capture<T>(read: () => T): Promise<T> {
    // Writes after this capture start a new batch behind it.
    this.open = undefined
    const result = this.pending.then(() => {
      if (this.overflow) throw new Error('Terminal renderer output limit exceeded; reconnect required')
      return read()
    })
    this.pending = result.then(() => {}, () => {})
    return result
  }
  serialize(): string { return this.serializer.serialize() + cursorVisibilitySequence(this.cursor.hidden) }
  view(): ScreenView { return screenView(this.terminal) }
  /** What this screen holds (lib/memory.ts): its emulator and the output waiting for the parser. */
  retainedBytes(): number { return terminalBytes(this.terminal) + this.queuedBytes }
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
