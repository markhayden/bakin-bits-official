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

export function claimSize(session: Pick<Session, 'sizeEpoch'>, viewer: string, claimant: SizeClaimant): Pick<Session, 'sizeAuthority' | 'sizeEpoch'> {
  return { sizeAuthority: { viewer, ...claimant }, sizeEpoch: session.sizeEpoch + 1 }
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
