/**
 * Pastes from viewers (spec D9 item 2). A viewer does not decide whether
 * the program enabled bracketed paste (tmux knows the pane's mode). So a
 * viewer marks a paste as one
 * (the socket's `paste` input), and the server hands the text to tmux as a
 * paste (paste-buffer -p), which adds the markers only if the program
 * itself enabled bracketed paste. Plain input is never reinterpreted.
 */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

/**
 * Paste text without any bracketed-paste markers (a viewer that bracketed
 * it itself, or markers inside the text), removed until none can be
 * rebuilt from the pieces: tmux brackets it, so the text cannot end the
 * paste early.
 */
export function stripPasteMarkers(text: string): string {
  let stripped = text
  for (let previous = ''; previous !== stripped;) {
    previous = stripped
    stripped = stripped.split(PASTE_START).join('').split(PASTE_END).join('')
  }
  return stripped
}
