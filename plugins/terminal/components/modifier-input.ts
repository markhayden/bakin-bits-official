import { activeModifiers, afterSend, consumeModifiers, encodeTerminalKey, NO_MODIFIERS, toggleModifier, type Modifier, type ModifierState, type TerminalKey } from './terminal-input'

type Timer = ReturnType<typeof setTimeout>
export interface Scheduler { set(fn: () => void, ms: number): Timer; clear(timer: Timer | undefined): void }
const realTime: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) }

/** How long a finished IME composition waits for xterm to deliver its text. */
export const COMPOSITION_COMMIT_MS = 200

/**
 * The bar's modifiers between the key bar and the terminal (spec D9 item 9).
 * xterm's onData carries the operator's typing, but also xterm's own
 * replies (focus reports, cursor-position answers) and the encoded bytes of
 * bar keys. Only the operator's single keystrokes take a modifier and
 * consume a one-shot one: bar keys are already encoded, paste and IME
 * composition are sent as typed, and xterm's own replies are left alone.
 */
export class ModifierInput {
  private state: ModifierState = NO_MODIFIERS
  private passthrough = false
  private user = false
  private pasting = false
  private userTimer: Timer | undefined
  private composing = false
  private committed = false
  private commitTimer: Timer | undefined

  constructor(private readonly notify: (state: ModifierState) => void, private readonly time: Scheduler = realTime) {}

  get modifiers(): ModifierState { return this.state }

  private set(next: ModifierState) {
    if (next === this.state) return
    this.state = next
    this.notify(next)
  }
  /** Disconnection, ownership/session change, backgrounding: release everything, locks included. */
  reset() { this.set(NO_MODIFIERS) }
  /** A send, or leaving the terminal: one-shot modifiers end, locks stay. */
  clearOnce() { this.set(afterSend(this.state)) }
  toggle(modifier: Modifier, action: 'tap' | 'lock' = 'tap') { this.set(toggleModifier(this.state, modifier, action)) }

  /**
   * The operator acted on the terminal's input: data in this task is theirs.
   * The canvas listens in capture on xterm's container, so this runs before
   * xterm's own handlers. A new keystroke after a composition ended means
   * that composition committed nothing (xterm's deferred read came first).
   */
  userEvent(kind: 'keydown' | 'keypress' | 'beforeinput' | 'input' = 'keydown') {
    if (this.committed && (kind === 'keydown' || kind === 'keypress')) this.endComposition()
    this.user = true
    this.time.clear(this.userTimer)
    this.userTimer = this.time.set(() => { this.user = false; this.pasting = false }, 0)
  }
  /** Paste is the operator's, and sent exactly as pasted: no modifier, lock or not. */
  paste() { this.userEvent('input'); this.pasting = true; this.clearOnce() }
  private endComposition() {
    this.time.clear(this.commitTimer)
    this.composing = false
    this.committed = false
  }
  compositionStart() {
    this.time.clear(this.commitTimer)
    this.composing = true
    this.committed = false
    this.clearOnce()
  }
  /** xterm delivers the composed text after compositionend (a deferred read): stay raw until it arrives. */
  compositionEnd() {
    this.committed = true
    this.time.clear(this.commitTimer)
    this.commitTimer = this.time.set(() => this.endComposition(), COMPOSITION_COMMIT_MS)
  }

  /** A bar key: encode it with the current modifiers, consume the one-shot ones, and let `deliver` send the bytes untouched. */
  key(key: TerminalKey, application: boolean, deliver: (bytes: string) => void) {
    const bytes = encodeTerminalKey(key, application, activeModifiers(this.state))
    this.clearOnce()
    this.passthrough = true
    try { deliver(bytes) } finally { this.passthrough = false }
  }

  /** What to send for one onData event. */
  data(data: string): string {
    if (this.passthrough) return data
    if (this.composing) {
      if (this.committed) this.endComposition()
      return data
    }
    if (this.pasting) return data
    // xterm's own replies (focus reports, terminal answers) are not keystrokes.
    if (!this.user) return data
    const sent = consumeModifiers(data, activeModifiers(this.state))
    this.clearOnce()
    return sent
  }

  dispose() {
    this.time.clear(this.userTimer)
    this.time.clear(this.commitTimer)
  }
}
