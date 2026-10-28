/**
 * A session's ordered event log (spec D13): the pane's output bytes and its
 * layout changes, in the order tmux reported them, for the one consumer
 * that renders them (the server replica). Output is batched (at most
 * BATCH_BYTES, or BATCH_MS after its first byte) at arbitrary byte
 * boundaries; the consumer's parser carries state across them.
 *
 * The consumer is fed one event at a time, waiting for the promise it may
 * return. What waits for it is bounded (MAX_QUEUED_BYTES of output): past
 * that, or when the source fails (`%exit`, EOF, a protocol fault), the log
 * is invalid — the consumer learns why once, and nothing is delivered
 * after. With no consumer attached, events are not kept.
 */

export const BATCH_BYTES = 64 * 1024
export const BATCH_MS = 16
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024

export type LogEvent =
  /** `offset`: output bytes before this event in the log. */
  | { seq: number; kind: 'output'; offset: number; bytes: Uint8Array }
  | { seq: number; kind: 'layout'; cols: number; rows: number }

export interface LogConsumer {
  event(event: LogEvent): void | Promise<void>
  /** The log failed: no further events, and the consumer's state cannot be trusted. */
  invalid(reason: string): void
}

/** The window size in a `%layout-change` line, or undefined when it is not one. */
export function parseLayoutChange(line: string): { window: string; cols: number; rows: number } | undefined {
  const match = /^%layout-change (@\d+) [0-9a-f]{4},(\d+)x(\d+),/.exec(line)
  return match ? { window: match[1]!, cols: Number(match[2]), rows: Number(match[3]) } : undefined
}

export class OutputLog {
  private seq = 0
  private offset = 0
  private batch: Uint8Array[] = []
  private batchBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: LogEvent[] = []
  private queuedBytes = 0
  private delivering = false
  private consumer: LogConsumer | undefined
  private failure: string | undefined

  /** Why the log is invalid, once it is. */
  get invalidReason(): string | undefined { return this.failure }
  get pendingBytes(): number { return this.queuedBytes + this.batchBytes }

  /** The one consumer. Events before it attached are not replayed: it starts from a known state (D13 reseed). */
  attach(consumer: LogConsumer): () => void {
    if (this.consumer) throw new Error('The output log already has a consumer')
    this.consumer = consumer
    if (this.failure) consumer.invalid(this.failure)
    return () => {
      if (this.consumer !== consumer) return
      this.consumer = undefined
      this.queue = []
      this.queuedBytes = 0
    }
  }

  output(bytes: Uint8Array): void {
    if (this.failure || bytes.length === 0) return
    this.batch.push(bytes)
    this.batchBytes += bytes.length
    if (this.batchBytes >= BATCH_BYTES) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), BATCH_MS)
  }

  /** A window size change, ordered after every output byte before it. */
  layout(cols: number, rows: number): void {
    if (this.failure) return
    this.flush()
    this.push({ seq: ++this.seq, kind: 'layout', cols, rows })
  }

  /** Emit the pending output batch now (a barrier: everything before it is in the log). */
  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.failure || this.batchBytes === 0) return
    let remaining = this.batchBytes
    const parts = this.batch
    this.batch = []
    this.batchBytes = 0
    // One event per BATCH_BYTES at most, cut anywhere: the consumer's parser carries state.
    const all = parts.length === 1 ? parts[0]! : concat(parts, remaining)
    for (let start = 0; remaining > 0 && !this.failure; start += BATCH_BYTES) {
      const bytes = all.subarray(start, start + BATCH_BYTES)
      remaining -= bytes.length
      this.push({ seq: ++this.seq, kind: 'output', offset: this.offset, bytes })
      this.offset += bytes.length
    }
  }

  invalidate(reason: string): void {
    if (this.failure) return
    this.failure = reason
    clearTimeout(this.timer)
    this.timer = undefined
    this.batch = []
    this.batchBytes = 0
    this.queue = []
    this.queuedBytes = 0
    this.consumer?.invalid(reason)
  }

  private push(event: LogEvent): void {
    if (!this.consumer || this.failure) return
    this.queue.push(event)
    if (event.kind === 'output') this.queuedBytes += event.bytes.length
    if (this.queuedBytes > MAX_QUEUED_BYTES) { this.invalidate('overflow'); return }
    void this.deliver()
  }

  private async deliver(): Promise<void> {
    if (this.delivering) return
    this.delivering = true
    try {
      while (this.queue.length && this.consumer && !this.failure) {
        const event = this.queue.shift()!
        const consumer = this.consumer
        try {
          await consumer.event(event)
        } catch (error) {
          this.invalidate(`consumer failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        } finally {
          // A failure or a detach already emptied the accounting.
          if (event.kind === 'output' && this.consumer === consumer && !this.failure) this.queuedBytes -= event.bytes.length
        }
      }
    } finally {
      this.delivering = false
    }
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const all = new Uint8Array(length)
  let at = 0
  for (const part of parts) { all.set(part, at); at += part.length }
  return all
}
