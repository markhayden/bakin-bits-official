/**
 * How one device renders a session's single real grid (spec D10). The screen
 * that sizes the session fits the grid to its pane at its own font; every
 * other screen keeps the grid and fits the FONT to its width, never below a
 * per-device minimum (adjustable, remembered), then pans natively on both
 * axes. Pinch (or Ctrl+wheel) sets a per-device font that overrides the fit
 * until "Reset view". Both live in this browser's storage, which may be absent.
 */
import type { Session } from '../lib/contracts'

export const BASE_FONT = 13
export const MAX_FONT = 32
const ZOOM_KEY = 'bakin-terminal-font'
const MIN_KEY = 'bakin-terminal-min-font'
/** The choices for "Smallest text" (px). */
export const MIN_FONTS = [8, 10, 12, 14] as const

export type ScreenDevice = 'desktop' | 'phone'

/** This device's chosen floor, else a larger one for touch screens (below 10px a phone grid is unreadable). */
export function minFont(view: Pick<Window, 'matchMedia'> = window, storage: () => Storage = () => window.localStorage): number {
  const chosen = readNumber(MIN_KEY, storage)
  if (chosen !== undefined && (MIN_FONTS as readonly number[]).includes(chosen)) return chosen
  return view.matchMedia('(pointer: coarse)').matches ? 10 : 8
}

export function storeMinFont(size: number, storage: () => Storage = () => window.localStorage): void {
  writeNumber(MIN_KEY, size, storage)
}

/** Names this screen in "Sized by …": a coarse pointer on a small screen is a phone. */
export function screenDevice(view: Pick<Window, 'matchMedia' | 'screen'> = window): ScreenDevice {
  return view.matchMedia('(pointer: coarse)').matches && Math.min(view.screen.width, view.screen.height) < 768 ? 'phone' : 'desktop'
}

export function clampFont(size: number, min: number): number {
  return Math.max(min, Math.min(MAX_FONT, Math.round(size)))
}

/** The font at which `screenWidth` (rendered at `current`) fills `paneWidth`. Cell width scales with the font. */
export function fitWidthFont(current: number, paneWidth: number, screenWidth: number, min: number): number {
  return clampFont(Math.floor((current * paneWidth) / screenWidth), min)
}

/** Pinch scales the font from where the gesture started. */
export function pinchFont(start: number, startDistance: number, distance: number, min: number): number {
  return clampFont(start * (distance / startDistance), min)
}

/** This device's pinched font, if any. */
export function storedFont(storage: () => Storage = () => window.localStorage): number | undefined {
  return readNumber(ZOOM_KEY, storage)
}

export function storeFont(size: number | undefined, storage: () => Storage = () => window.localStorage): void {
  writeNumber(ZOOM_KEY, size, storage)
}

// Storage can be absent or throw (private mode, blocked site data): the view
// still applies for this page, it just isn't remembered.
function readNumber(key: string, storage: () => Storage): number | undefined {
  try {
    const raw = storage().getItem(key)
    const value = Number(raw)
    return raw !== null && Number.isFinite(value) && value >= 6 && value <= MAX_FONT ? value : undefined
  } catch {
    return undefined
  }
}

function writeNumber(key: string, value: number | undefined, storage: () => Storage): void {
  try {
    if (value === undefined) storage().removeItem(key)
    else storage().setItem(key, String(value))
  } catch {
    // Not remembered; see readNumber.
  }
}

export interface Box { left: number; top: number; width: number; height: number }
export interface ScrollView { scrollLeft: number; scrollTop: number; clientWidth: number; clientHeight: number }

/** The smallest scroll that brings `target` (in content coordinates) into view, with `margin` around it. */
export function reveal(view: ScrollView, target: Box, margin = 0): { left: number; top: number } {
  const axis = (scroll: number, size: number, start: number, length: number) => {
    if (start - margin < scroll) return Math.max(0, start - margin)
    if (start + length + margin > scroll + size) return Math.max(0, start + length + margin - size)
    return scroll
  }
  return { left: axis(view.scrollLeft, view.clientWidth, target.left, target.width), top: axis(view.scrollTop, view.clientHeight, target.top, target.height) }
}

/** Who "Sized by …" names. Agents never size a session, so they never appear here. */
export function sizedBy(session: Pick<Session, 'sizeAuthority'>, me: string): string | undefined {
  const authority = session.sizeAuthority
  if (!authority) return undefined
  if (authority.kind === 'native') return 'terminal app'
  return authority.viewer === me ? 'this device' : authority.device
}

/**
 * The sizing screen's next step from the grid its pane holds (`proposed`)
 * and the grid the session has (`current`): a height change goes now, at the
 * current width; a width change waits out the debounce. Run on every pane
 * change AND every acknowledged size, so a pane that moved back before the
 * server answered is reconciled.
 */
export function resizePlan(proposed: { cols: number; rows: number }, current: { cols: number; rows: number }): { now?: { cols: number; rows: number }; later: boolean } {
  return { ...(proposed.rows !== current.rows ? { now: { cols: current.cols, rows: proposed.rows } } : {}), later: proposed.cols !== current.cols }
}
