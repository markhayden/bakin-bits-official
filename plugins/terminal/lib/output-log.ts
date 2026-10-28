/**
 * A session's ordered event log (spec D13): the pane's output bytes and its
 * layout changes (and the captures landed among them), in the order tmux reported them, for the one consumer
 * that renders them (the server replica). Output is batched (at most
 * BATCH_BYTES, or BATCH_MS after its first byte) at arbitrary byte
 * boundaries; the consumer's parser carries state across them.
 *
 * The consumer is fed one event at a time, waiting for the promise it may
 * return. What waits for it (events not yet handed over, a seed included)
 * is bounded (MAX_QUEUED_BYTES): past that, or when the source fails
 * (`%exit`, EOF, a protocol fault), the log is invalid — the consumer
 * learns why once, and nothing is delivered after. With no consumer
 * attached, events are not kept.
 */

export const BATCH_BYTES = 64 * 1024
export const BATCH_MS = 16
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024
/** Events (layout changes included) waiting for the consumer before the log overflows. */
export const MAX_QUEUED_EVENTS = 4096

export type LogEvent =
  /** `offset`: output bytes before this event in the log. */
  | { seq: number; kind: 'output'; offset: number; bytes: Uint8Array }
  | { seq: number; kind: 'layout'; cols: number; rows: number }
  /** Reset to this picture (lib/reseed.ts); output after it follows the seed. */
  /** `history`: the seed carries the pane's history (a `screen` seed does not, lib/reseed.ts). */
  | { seq: number; kind: 'seed'; bytes: Uint8Array; cols: number; rows: number; reason: string; history: boolean }
  /**
   * tmux's picture at a width change (lib/reseed.ts, plan T34a): not a reset —
   * the consumer installs its geometry (lib/geometry.ts) and keeps its state.
   * `generation`: the width change it was asked for (later ones need another).
   */
  | { seq: number; kind: 'geometry'; bytes: Uint8Array; cols: number; rows: number; generation: number; history: boolean }

export interface LogConsumer {
  event(event: LogEvent): void | Promise<void>
  /**
   * Output bytes waiting for the consumer (seeds not counted), after every
   * event the log takes in, synchronously: a consumer that falls behind
   * learns it at ingress, not only when its next event arrives. A throw
   * fails the log like a failed event.
   */
  pressure?(queuedOutputBytes: number): void
  /** The log failed: no further events, and the consumer's state cannot be trusted. */
  invalid(reason: string): void
}

/** The window size in a `%layout-change` line, or undefined when it is not one. */
export function parseLayoutChange(line: string): { window: string; cols: number; rows: number } | undefined {
  const match = /^%layout-change (@\d+) [0-9a-f]{4},(\d+)x(\d+),/.exec(line)
  return match ? { window: match[1]!, cols: Number(match[2]), rows: Number(match[3]) } : undefined
}

/** One consumer's attachment: its own queue and delivery, so a detached one can never touch its successor. */
interface Attachment { consumer: LogConsumer; queue: LogEvent[]; queuedBytes: number; queuedOutputBytes: number; delivering: boolean; live: boolean }

export class OutputLog {
  private seq = 0
  private offset = 0
  private batch: Uint8Array[] = []
  private batchBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private attachment: Attachment | undefined
  private failure: string | undefined

  /** Why the log is invalid, once it is. */
  get invalidReason(): string | undefined { return this.failure }
  get pendingBytes(): number { return (this.attachment?.queuedBytes ?? 0) + this.batchBytes }
  /** Events waiting for the consumer, and batched output not yet an event. */
  get pendingEvents(): number { return (this.attachment?.queue.length ?? 0) + this.batch.length }

  /** The one consumer. Nothing from before it attached reaches it: it starts from a known state (D13 reseed). */
  attach(consumer: LogConsumer): () => void {
    if (this.attachment) throw new Error('The output log already has a consumer')
    const attachment: Attachment = { consumer, queue: [], queuedBytes: 0, queuedOutputBytes: 0, delivering: false, live: true }
    this.attachment = attachment
    if (this.failure) consumer.invalid(this.failure)
    return () => {
      if (this.attachment !== attachment) return
      attachment.live = false
      // A stalled delivery may keep the attachment reachable: release its queue now.
      attachment.queue = []
      attachment.queuedBytes = 0
      attachment.queuedOutputBytes = 0
      this.attachment = undefined
      // Output not yet delivered belonged to this consumer's stream only.
      this.dropBatch()
    }
  }

  output(bytes: Uint8Array): void {
    // Without a consumer, output is not kept.
    if (this.failure || bytes.length === 0 || !this.attachment) return
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

  /**
   * A reseed's boundary: everything already received is queued before it,
   * everything after follows it. Its bytes count against the bound. False
   * when the seed was not kept (no consumer, or the log is or became invalid).
   */
  seed(bytes: Uint8Array, cols: number, rows: number, reason: string, history = true): boolean {
    if (this.failure || !this.attachment) return false
    this.flush()
    this.push({ seq: ++this.seq, kind: 'seed', bytes, cols, rows, reason, history })
    return !this.failure
  }

  /** A geometry capture's boundary (ordered like `seed`); false when it was not kept. */
  geometry(bytes: Uint8Array, cols: number, rows: number, generation: number, history = true): boolean {
    if (this.failure || !this.attachment) return false
    this.flush()
    this.push({ seq: ++this.seq, kind: 'geometry', bytes, cols, rows, generation, history })
    return !this.failure
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
    this.dropBatch()
    const attachment = this.attachment
    if (!attachment) return
    attachment.queue = []
    attachment.queuedBytes = 0
    attachment.queuedOutputBytes = 0
    attachment.consumer.invalid(reason)
  }

  private dropBatch(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.batch = []
    this.batchBytes = 0
  }

  private push(event: LogEvent): void {
    const attachment = this.attachment
    if (!attachment || this.failure) return
    attachment.queue.push(event)
    if (event.kind !== 'layout') attachment.queuedBytes += event.bytes.length
    if (event.kind === 'output') attachment.queuedOutputBytes += event.bytes.length
    if (attachment.queuedBytes > MAX_QUEUED_BYTES || attachment.queue.length > MAX_QUEUED_EVENTS) { this.invalidate('overflow'); return }
    try {
      attachment.consumer.pressure?.(attachment.queuedOutputBytes)
    } catch (error) {
      this.invalidate(`consumer failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    void this.deliver(attachment)
  }

  private async deliver(attachment: Attachment): Promise<void> {
    if (attachment.delivering) return
    attachment.delivering = true
    try {
      while (attachment.live && !this.failure && attachment.queue.length) {
        const event = attachment.queue.shift()!
        // Handed over: it no longer waits.
        if (event.kind !== 'layout') attachment.queuedBytes -= event.bytes.length
        if (event.kind === 'output') attachment.queuedOutputBytes -= event.bytes.length
        try {
          await attachment.consumer.event(event)
        } catch (error) {
          // A consumer that has been replaced cannot fail its successor's log.
          if (attachment.live) this.invalidate(`consumer failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
    } finally {
      attachment.delivering = false
    }
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const all = new Uint8Array(length)
  let at = 0
  for (const part of parts) { all.set(part, at); at += part.length }
  return all
}
