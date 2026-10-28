export const CONTROL_SHORTCUTS = ['C', 'D', 'Z', 'R', 'L', 'A', 'E', 'U', 'K', 'W'] as const
export const EDITING_KEYS = ['Enter', 'Backspace', 'Delete', 'Shift+Tab', 'Home', 'End', 'Page Up', 'Page Down'] as const
export type TerminalKey = 'Esc' | 'Tab' | 'Up' | 'Down' | 'Left' | 'Right' | typeof EDITING_KEYS[number] | `Ctrl+${typeof CONTROL_SHORTCUTS[number]}`
export type ArrowKey = 'Up' | 'Down' | 'Left' | 'Right'

/** What each Ctrl shortcut does, in the words the ••• menu shows (spec D9 item 9). */
export const CONTROL_LABELS: Record<typeof CONTROL_SHORTCUTS[number], string> = {
  C: 'Interrupt', D: 'End input', Z: 'Suspend', R: 'Search history', L: 'Clear screen',
  A: 'Line start', E: 'Line end', U: 'Delete line', K: 'Delete to end', W: 'Delete word',
}
/** The ••• menu's Keys group, in menu order (all four arrows stay one tap away here). */
export const MENU_KEYS = ['Enter', 'Backspace', 'Delete', 'Shift+Tab', 'Home', 'End', 'Page Up', 'Page Down', 'Left', 'Down', 'Up', 'Right'] as const satisfies readonly TerminalKey[]
/** Pinned keys a device starts with: the most common ones after Esc, Tab, Ctrl and the arrow (Mark, 2026-10-27). */
export const DEFAULT_PINS = ['Shift+Tab', 'Ctrl+C', 'Ctrl+R', 'Enter'] as const satisfies readonly TerminalKey[]

/** A key's face on the bar: short, the way terminals and docs write it. Its accessible name is the key itself. */
export function keyFace(key: TerminalKey): string {
  if (key.startsWith('Ctrl+')) return '^' + key.slice(5)
  return ({ 'Shift+Tab': '⇧Tab', Backspace: '⌫', Delete: 'Del', 'Page Up': 'PgUp', 'Page Down': 'PgDn', Up: '↑', Down: '↓', Left: '←', Right: '→' } as Partial<Record<TerminalKey, string>>)[key] ?? key
}

const cursor = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' } as const
const editing = { Delete: 3, 'Page Up': 5, 'Page Down': 6 } as const
const simple = { Esc: '\x1b', Tab: '\t', Enter: '\r', Backspace: '\x7f', 'Shift+Tab': '\x1b[Z' } as const

/** Matches xterm 6's public keyboard protocol, including DECCKM cursor mode. */
export function encodeTerminalKey(key: TerminalKey, application: boolean, ctrl = false): string {
  if (key.startsWith('Ctrl+')) return String.fromCharCode(key.charCodeAt(5) & 31)
  if (key in cursor) {
    const suffix = cursor[key as keyof typeof cursor]
    return ctrl ? '\x1b[1;5' + suffix : (application ? '\x1bO' : '\x1b[') + suffix
  }
  if (key in editing) return '\x1b[' + editing[key as keyof typeof editing] + (ctrl ? ';5~' : '~')
  return simple[key as keyof typeof simple]
}

/** Every next input consumes the latch, even when its combination is unsupported. */
export function consumeControl(data: string, armed: boolean, source: 'text' | 'paste' | 'composition' = 'text'): { data: string; armed: false } {
  if (armed && source === 'text') {
    if (/^[a-z]$/i.test(data)) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
    else if (data.startsWith('\x1b') && /^(?:O|\[)[ABCDHF]$/.test(data.slice(1))) data = '\x1b[1;5' + data.at(-1)
    else if (data.startsWith('\x1b') && /^\[[356]~$/.test(data.slice(1))) data = data.slice(0, -1) + ';5~'
  }
  return { data, armed: false }
}

export interface TerminalInputHandle {
  /** Focus the terminal's input (opens the on-screen keyboard when called from a tap). */
  focus(): void
  key(key: TerminalKey): void
  toggleCtrl(): void
  reset(): void
  /** Send typed/pasted text for `generation` over the viewer socket; false when not connected. */
  send(generation: number, data: string): boolean
}
