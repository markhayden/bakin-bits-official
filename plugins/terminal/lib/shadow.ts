/**
 * Shadow mode (spec D13 delivery step 2, plan T32c): the replica runs dark
 * beside the bridge, and at quiet points its screen is compared with the
 * bridge's headless screen. Mismatches are logged by kind and row, never
 * with contents.
 *
 * Compared: the size, the visible rows' text and the cursor position.
 * Documented differences, not compared:
 * - attributes and colours (tmux redraws them in its own encoding);
 * - trailing blanks (tmux erases with spaces where the program left empty
 *   cells);
 * - scrollback (the bridge's history is tmux's redraws, not the program's);
 * - a pending wrap (the cursor past the last column is compared at it);
 * - cursor visibility, title, bells;
 * - what only tmux draws on its clients: copy mode (a terminal app
 *   scrolling the pane shows on the bridge too) and its messages. These
 *   are logged as mismatches; the log says how to read them.
 */
import type { Term } from './terminal-state'

export interface ScreenView { cols: number; rows: number; text: string[]; cursor: { x: number; y: number } }
export type ShadowMismatch = { kind: 'size' } | { kind: 'row'; row: number } | { kind: 'cursor' }

/** The visible screen of `terminal`'s active buffer. */
export function screenView(terminal: Term): ScreenView {
  const buffer = terminal.buffer.active
  const text = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
  return { cols: terminal.cols, rows: terminal.rows, text, cursor: { x: Math.min(buffer.cursorX, terminal.cols - 1), y: buffer.cursorY } }
}

/** The first difference between the bridge's screen and the replica's that is not a documented one. */
export function shadowDiff(bridge: ScreenView, replica: ScreenView): ShadowMismatch | null {
  if (bridge.cols !== replica.cols || bridge.rows !== replica.rows) return { kind: 'size' }
  for (let row = 0; row < bridge.rows; row++) if (bridge.text[row]!.trimEnd() !== replica.text[row]!.trimEnd()) return { kind: 'row', row }
  if (bridge.cursor.x !== replica.cursor.x || bridge.cursor.y !== replica.cursor.y) return { kind: 'cursor' }
  return null
}
