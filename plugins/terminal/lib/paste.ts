/**
 * Bracketed paste for input from viewers and agents (spec D9 item 2). A
 * viewer cannot know whether the program enabled bracketed paste: on the
 * bridge path its terminal's mode is tmux's client mode, which tmux turns
 * on for every client it attaches (tty_start) whatever the pane wants. So a
 * complete bracketed paste in the input is handed to tmux as a paste
 * (paste-buffer -p), and tmux adds the markers only if the program itself
 * enabled bracketed paste.
 */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

export type InputPart = { paste: boolean; text: string }

/** `data` as plain input and complete bracketed pastes, in order; an unterminated start marker stays plain input. */
export function inputParts(data: string): InputPart[] {
  const parts: InputPart[] = []
  let at = 0
  for (let start = data.indexOf(PASTE_START); start !== -1; start = data.indexOf(PASTE_START, at)) {
    const end = data.indexOf(PASTE_END, start + PASTE_START.length)
    if (end === -1) break
    if (start > at) parts.push({ paste: false, text: data.slice(at, start) })
    parts.push({ paste: true, text: data.slice(start + PASTE_START.length, end) })
    at = end + PASTE_END.length
  }
  if (at < data.length) parts.push({ paste: false, text: data.slice(at) })
  return parts
}
