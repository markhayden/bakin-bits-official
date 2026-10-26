/**
 * A pre-mount estimate of the grid this screen's terminal pane will hold, so
 * a session starts near the size it is first seen at; the canvas fits it
 * exactly once it mounts (the creator holds the size claim). Cell metrics are
 * xterm's 13px font in the system monospace face; the chrome allowance covers
 * the workspace header, the canvas inset and, on touch screens, the key strip.
 */
const CELL = { width: 7.8, height: 17 }

export function estimateTerminalSize(view: { innerWidth: number; innerHeight: number; matchMedia(query: string): { matches: boolean } } = window): { cols: number; rows: number } {
  const touch = view.matchMedia('(pointer: coarse)').matches
  const width = view.innerWidth - 32
  const height = view.innerHeight - 96 - (touch ? 112 : 0)
  return { cols: Math.max(1, Math.floor(width / CELL.width)), rows: Math.max(1, Math.floor(height / CELL.height)) }
}
