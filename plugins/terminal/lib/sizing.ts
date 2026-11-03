/**
 * Who sizes a session's one real grid (spec D2): an explicit claim, never
 * typing or viewing. A claim opens a new size epoch; only the authority at
 * the current epoch may resize, so a former authority's delayed resize is
 * stale. `sizeRevision` counts actual dimension changes (agents re-read the
 * screen after it moves).
 */
import { TerminalError, type Session, type SizeClaimant } from './contracts'

/** The smallest grid any claim may produce; smaller panes pan locally. */
export const FLOOR = { cols: 40, rows: 10 } as const
export const MAX = { cols: 400, rows: 150 } as const

export interface SizeRequest { viewer: string; epoch: number; cols: number; rows: number }

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: Math.min(MAX.cols, Math.max(FLOOR.cols, cols)), rows: Math.min(MAX.rows, Math.max(FLOOR.rows, rows)) }
}

/** Pure: a handoff to another screen remembers the grid it leaves, so it can be restored. */
export function claimSize(session: Pick<Session, 'cols' | 'rows' | 'sizeEpoch' | 'sizeAuthority' | 'previousSize'>, viewer: string, claimant: SizeClaimant): Pick<Session, 'sizeAuthority' | 'sizeEpoch' | 'previousSize'> {
  const current = session.sizeAuthority
  const previousSize = current && current.viewer !== viewer ? { cols: session.cols, rows: session.rows, authority: current } : session.previousSize
  return { sizeAuthority: { viewer, ...claimant }, sizeEpoch: session.sizeEpoch + 1, previousSize }
}

/** Pure: hand the size back to the previous authority at its grid; the current one becomes the previous (a toggle). */
export function restoreSize(session: Pick<Session, 'cols' | 'rows' | 'sizeEpoch' | 'sizeAuthority' | 'previousSize'>, epoch: number): Pick<Session, 'sizeAuthority' | 'sizeEpoch' | 'previousSize'> & { cols: number; rows: number } {
  // Decided against what the screen showed: a handoff since (another screen went back first) makes it stale.
  if (epoch !== session.sizeEpoch) throw new TerminalError('The size changed meanwhile; check who sizes it now', 409)
  const previous = session.previousSize
  if (!previous) throw new TerminalError('There is no previous size to go back to', 409)
  const current = session.sizeAuthority
  return {
    ...clampSize(previous.cols, previous.rows),
    sizeAuthority: previous.authority,
    sizeEpoch: session.sizeEpoch + 1,
    previousSize: current ? { cols: session.cols, rows: session.rows, authority: current } : undefined,
  }
}

/** Pure: only the current authority at the current epoch may resize. */
export function nextSize(session: Pick<Session, 'cols' | 'rows' | 'sizeEpoch' | 'sizeRevision' | 'sizeAuthority'>, request: SizeRequest): Pick<Session, 'cols' | 'rows' | 'sizeRevision'> {
  if (request.viewer !== session.sizeAuthority?.viewer || request.epoch !== session.sizeEpoch) {
    throw new TerminalError('Another device is sizing this session', 409)
  }
  const { cols, rows } = clampSize(request.cols, request.rows)
  const changed = cols !== session.cols || rows !== session.rows
  return { cols, rows, sizeRevision: session.sizeRevision + (changed ? 1 : 0) }
}
