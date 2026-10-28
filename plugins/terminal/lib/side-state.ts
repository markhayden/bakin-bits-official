/**
 * The last step of every checkpoint restore (lib/checkpoint.ts), apart so
 * the browser can stream a restore (components/raw-picture.ts) without the
 * headless serializer: what the checkpoint's text cannot carry, set once
 * that text is parsed.
 */
import { HAS_EXTENDED, setAltEnteredCols, setAltEntry } from './xterm-fixes'

/** What a restore sets once the checkpoint's text is parsed. */
export interface CheckpointSideState {
  /** The parser's grapheme join state after the text (xterm's packed character properties; 0 for none). */
  joinState: number
  /** The pen's HAS_EXTENDED bit: a link it holds with the bit clear is latent. */
  penHasExtended: boolean
  /** The columns the alternate screen was entered at, while it is active (xterm-fixes' tab stops). */
  altEnteredCols: number | null
  /** How the active alternate screen was entered (xterm-fixes' altEntry: a width rebase reads it). */
  altEntry: 'saved' | 'unsaved' | null
}

interface RestoreInternals {
  _inputHandler: { _parser: { precedingJoinState: number }; _curAttrData: { bg: number } }
}

/**
 * Set what the bytes cannot carry, once they are parsed. A streamed restore
 * writes the checkpoint's UTF-8 in any pieces (split inside a character
 * too: xterm's decoder carries it) and calls this from the last write's
 * callback, before anything else is written.
 */
export function restoreSideState(terminal: object, side: CheckpointSideState): void {
  const handler = (terminal as { _core: RestoreInternals })._core._inputHandler
  handler._parser.precedingJoinState = side.joinState
  if (side.penHasExtended) handler._curAttrData.bg |= HAS_EXTENDED
  else handler._curAttrData.bg &= ~HAS_EXTENDED
  if (side.altEnteredCols !== null) setAltEnteredCols(terminal, side.altEnteredCols)
  setAltEntry(terminal, side.altEntry)
}
