export const CONTROL_SHORTCUTS = ['C', 'D', 'Z', 'R', 'L', 'A', 'E', 'U', 'K', 'W'] as const
export const EDITING_KEYS = ['Enter', 'Backspace', 'Delete', 'Shift+Tab', 'Home', 'End', 'Page Up', 'Page Down'] as const
/** Characters the key sheet sends as typed text (awkward to reach on a phone keyboard). */
export const LITERAL_KEYS = ['|', '~', '/', '-'] as const
export type ArrowKey = 'Up' | 'Down' | 'Left' | 'Right'
export type TerminalKey = 'Esc' | 'Tab' | ArrowKey | typeof EDITING_KEYS[number] | typeof LITERAL_KEYS[number] | `Ctrl+${typeof CONTROL_SHORTCUTS[number]}`

/** What each Ctrl shortcut does, in the words the key sheet shows (spec D9 item 9). */
export const CONTROL_LABELS: Record<typeof CONTROL_SHORTCUTS[number], string> = {
  C: 'Interrupt', D: 'End input', Z: 'Suspend', R: 'Search history', L: 'Clear screen',
  A: 'Line start', E: 'Line end', U: 'Delete line', K: 'Delete to end', W: 'Delete word',
}
/** The key sheet's Keys group, in sheet order (the four ordinary arrows live here). */
// Rows of six: editing keys; the arrows with Home/End; paging and symbols.
export const SHEET_KEYS = ['Esc', 'Tab', 'Shift+Tab', 'Enter', 'Backspace', 'Delete', 'Left', 'Down', 'Up', 'Right', 'Home', 'End', 'Page Up', 'Page Down', '|', '~', '/', '-'] as const satisfies readonly TerminalKey[]

/** A key's face: short, the way terminals and docs write it. Its accessible name is the key itself. */
export function keyFace(key: TerminalKey): string {
  if (key.startsWith('Ctrl+')) return '^' + key.slice(5)
  return ({ Esc: 'esc', Tab: '⇥', 'Shift+Tab': '⇧⇥', Enter: '↵', Backspace: '⌫', Delete: 'Del', 'Page Up': 'PgUp', 'Page Down': 'PgDn', Up: '↑', Down: '↓', Left: '←', Right: '→' } as Partial<Record<TerminalKey, string>>)[key] ?? key
}

export type Modifier = 'ctrl' | 'alt'
/** Each bar modifier is off, armed for the next key (`once`), or held until released (`locked`). */
export type ModifierState = Record<Modifier, 'off' | 'once' | 'locked'>
export type ActiveModifiers = Record<Modifier, boolean>
export const NO_MODIFIERS: ModifierState = { ctrl: 'off', alt: 'off' }

/** A tap arms (or cancels); `lock` (a long press or the sheet's toggle) holds it until the next tap. */
export function toggleModifier(state: ModifierState, modifier: Modifier, action: 'tap' | 'lock' = 'tap'): ModifierState {
  const next = action === 'lock' ? 'locked' : state[modifier] === 'off' ? 'once' : 'off'
  return { ...state, [modifier]: next }
}
export function activeModifiers(state: ModifierState): ActiveModifiers {
  return { ctrl: state.ctrl !== 'off', alt: state.alt !== 'off' }
}
/** A send consumes one-shot modifiers; locks stay. */
export function afterSend(state: ModifierState): ModifierState {
  const ctrl = state.ctrl === 'once' ? 'off' : state.ctrl
  const alt = state.alt === 'once' ? 'off' : state.alt
  return ctrl === state.ctrl && alt === state.alt ? state : { ctrl, alt }
}

const cursor = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' } as const
const tilde = { Delete: 3, 'Page Up': 5, 'Page Down': 6 } as const
// xterm's modifier parameter: 1 + shift·1 + alt·2 + ctrl·4.
const parameter = (mods: ActiveModifiers) => 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
const prefix = (mods: ActiveModifiers, data: string) => (mods.alt ? '\x1b' : '') + data

/** Ctrl alone on one character, as xterm 6 maps keys; undefined when it has no control form. */
function control(char: string): string | undefined {
  if (/^[a-z]$/i.test(char)) return String.fromCharCode(char.toUpperCase().charCodeAt(0) & 31)
  if (char >= '3' && char <= '7') return String.fromCharCode(char.charCodeAt(0) - 51 + 27)
  return ({ ' ': '\x00', '@': '\x00', '8': '\x7f', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '_': '\x1f' } as Record<string, string>)[char]
}

/** Matches xterm 6's keyboard protocol (DECCKM included) for a key with the bar's modifiers. */
export function encodeTerminalKey(key: TerminalKey, application: boolean, mods: ActiveModifiers): string {
  if (key.startsWith('Ctrl+')) return prefix(mods, String.fromCharCode(key.charCodeAt(5) & 31))
  if (key in cursor) {
    const suffix = cursor[key as keyof typeof cursor]
    if (mods.ctrl || mods.alt) return '\x1b[1;' + parameter(mods) + suffix
    return (application ? '\x1bO' : '\x1b[') + suffix
  }
  if (key in tilde) {
    const code = tilde[key as keyof typeof tilde]
    // xterm modifies Page Up/Down only when Ctrl is held; Delete with any modifier.
    const modified = code === 3 ? mods.ctrl || mods.alt : mods.ctrl
    return '\x1b[' + code + (modified ? ';' + parameter(mods) : '') + '~'
  }
  switch (key) {
    case 'Esc': return prefix(mods, '\x1b')
    case 'Enter': return prefix(mods, '\r')
    case 'Backspace': return prefix(mods, mods.ctrl ? '\x08' : '\x7f')
    // xterm sends Tab and Shift+Tab unmodified by Ctrl or Alt.
    case 'Tab': return '\t'
    case 'Shift+Tab': return '\x1b[Z'
    default: return consumeModifiers(key, mods)
  }
}

/** Merge the bar's modifiers into an xterm modifier parameter (1 + shift·1 + alt·2 + ctrl·4). */
const merge = (existing: number, mods: ActiveModifiers) => ((existing - 1) | (mods.alt ? 2 : 0) | (mods.ctrl ? 4 : 0)) + 1

/**
 * The bar's modifiers applied to what the terminal's input produced: one
 * typed character, or a key from a hardware keyboard (its own modifiers
 * merged with the bar's). Words (autocorrect, dictation), paste and IME
 * composition are sent as typed.
 */
export function consumeModifiers(data: string, mods: ActiveModifiers, source: 'text' | 'paste' | 'composition' = 'text'): string {
  if (source !== 'text' || !(mods.ctrl || mods.alt)) return data
  if (data.startsWith('\x1b') && data.length > 1) {
    const sequence = data.slice(1)
    const cursorKey = /^(?:O|\[)([ABCDHF])$/.exec(sequence)
    if (cursorKey) return '\x1b[1;' + parameter(mods) + cursorKey[1]
    const modifiedCursor = /^\[1;(\d+)([ABCDHF])$/.exec(sequence)
    if (modifiedCursor) return '\x1b[1;' + merge(Number(modifiedCursor[1]), mods) + modifiedCursor[2]
    // A key the keyboard already ESC-prefixed (Meta/Alt): the bar's Control applies as xterm's Ctrl+Alt does.
    if (sequence.length === 1) {
      if (!mods.ctrl) return data
      if (sequence === '\x7f') return '\x1b\x08'
      if (/^[a-z]$/i.test(sequence) || sequence === ' ') return '\x1b' + control(sequence)!
      return data
    }
    const tildeKey = /^\[([356])(?:;(\d+))?~$/.exec(sequence)
    if (tildeKey) {
      const existing = Number(tildeKey[2] ?? 1)
      // Page Up/Down take modifiers only once Ctrl is part of them (xterm); Delete always.
      const ctrlHeld = mods.ctrl || ((existing - 1) & 4) !== 0
      const parameterNow = tildeKey[1] === '3' || ctrlHeld ? merge(existing, mods) : existing
      return '\x1b[' + tildeKey[1] + (parameterNow > 1 ? ';' + parameterNow : '') + '~'
    }
    return data
  }
  if (data === '\r') return prefix(mods, '\r')
  // A typed DEL is Backspace, an autocorrect/Android deletion, or a hardware
  // Ctrl+8: it is sent as typed (the sheet's ⌫ takes the modifiers).
  if (data === '\x7f') return data
  if (data === '\t') return data
  // A control character a hardware keyboard already made (Ctrl+C, Escape): Option still prefixes it.
  if (data.length === 1 && data < ' ') return prefix(mods, data)
  if (data.length !== 1 || data > '~') return data
  if (mods.alt) {
    // xterm: Option + letter or space carries Ctrl too; Option + anything else is ESC + the character.
    if (/^[a-z]$/i.test(data) || data === ' ') return '\x1b' + (mods.ctrl ? control(data)! : data)
    return '\x1b' + data
  }
  return control(data) ?? data
}

export interface TerminalInputHandle {
  /** Focus the terminal's input (opens the on-screen keyboard when called from a tap). */
  focus(): void
  /** Take focus off the terminal's input (closes the on-screen keyboard). */
  blur(): void
  /** Send one key with the current bar modifiers, then consume the one-shot ones. */
  key(key: TerminalKey): void
  /** Tap (arm/cancel) or lock a bar modifier. */
  modifier(modifier: Modifier, action?: 'tap' | 'lock'): void
  /** Clear every modifier, locks included. */
  reset(): void
  /** Send typed/pasted text for `generation` over the viewer socket; false when not connected. */
  send(generation: number, data: string): boolean
}
