import { activeModifiers, afterSend, consumeModifiers, encodeTerminalKey, NO_MODIFIERS, toggleModifier, type Modifier, type ModifierState, type TerminalKey } from './terminal-input'

type Timer = ReturnType<typeof setTimeout>
export interface Scheduler { set(fn: () => void, ms: number): Timer; clear(timer: Timer | undefined): void }
const realTime: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) }

/**
 * One key, as the terminal's input delivers it: a single character
 * (typed, IME-committed, or a hardware control character), an ESC-prefixed
 * single character (Meta/Alt), or a cursor/tilde key sequence, modified or not.
 */
export function isKey(data: string): boolean {
  if ([...data].length === 1) return true
  if (!data.startsWith('\x1b')) return false
  const sequence = data.slice(1)
  return [...sequence].length === 1
    // Cursor keys, Home/End, F1–F4 (SS3, or CSI 1;m when modified), Shift+Tab.
    || /^(?:O|\[)[ABCDHF]$/.test(sequence) || /^O[PQRS]$/.test(sequence) || /^\[1;\d+[ABCDHFPQS]$/.test(sequence) || sequence === '[Z'
    // Tilde keys: Insert, Delete, Page Up/Down, F5–F12, modified or not.
    || /^\[\d+(?:;\d+)?~$/.test(sequence)
  // Not CSI 1;m R: a modified F3 and a cursor-position reply are the same
  // bytes, so it stays a reply (untouched, consuming nothing).
}

/**
 * The bar's modifiers between the key bar and the terminal (spec D9 item 9).
 *
 * The contract is about what is sent, not which input path produced it:
 * xterm delivers typing through keypress, IME commits (deferred or flushed
 * by the next key), and Android's composition path alike, so the source
 * cannot be told apart reliably. Instead:
 * - one key takes the modifiers and consumes a one-shot one, however it
 *   arrived (a locked Control makes every key Control+key). This is a
 *   transformation per delivered chunk, not a held key: a dictated or
 *   predicted single letter is one key too;
 * - other text (words, autocorrect, dictation, CJK commits) is sent as
 *   typed and consumes a one-shot modifier;
 * - paste is sent exactly as pasted;
 * - ESC sequences that are not keys are xterm's own replies (focus reports,
 *   cursor-position answers, mouse reports): untouched and never consuming;
 * - bar keys arrive already encoded and pass through untouched.
 */
export class ModifierInput {
  private state: ModifierState = NO_MODIFIERS
  private passthrough = false
  private pasting = false
  private pasteTimer: Timer | undefined

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

  /** A paste event: xterm sends the clipboard text within it, exactly as pasted. */
  paste() {
    this.clearOnce()
    this.pasting = true
    this.time.clear(this.pasteTimer)
    this.pasteTimer = this.time.set(() => { this.pasting = false }, 0)
  }

  /** A bar key: encode it with the current modifiers, consume the one-shot ones, and let `deliver` send the bytes untouched. */
  key(key: TerminalKey, application: boolean, deliver: (bytes: string) => void) {
    const bytes = encodeTerminalKey(key, application, activeModifiers(this.state))
    this.clearOnce()
    this.passthrough = true
    try { deliver(bytes) } finally { this.passthrough = false }
  }

  /** Compose text, already encoded: sent untouched; one-shot modifiers end, locks stay. */
  text(bytes: string, deliver: (bytes: string) => void) {
    this.clearOnce()
    this.passthrough = true
    try { deliver(bytes) } finally { this.passthrough = false }
  }

  /** What to send for one onData event. */
  data(data: string): string {
    // xterm flushes an empty composition as "": it is not a key.
    if (!data || this.passthrough || this.pasting) return data
    if (isKey(data)) {
      const sent = consumeModifiers(data, activeModifiers(this.state))
      this.clearOnce()
      return sent
    }
    if (!data.startsWith('\x1b')) this.clearOnce()
    return data
  }

  dispose() { this.time.clear(this.pasteTimer) }
}
