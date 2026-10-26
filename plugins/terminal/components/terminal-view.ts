/**
 * How one device renders a session's single real grid (spec D10). The screen
 * that sizes the session fits the grid to its pane at its own font; every
 * other screen keeps the grid and fits the FONT to its width, never below a
 * per-device minimum, then pans natively on both axes. Pinch (or Ctrl+wheel)
 * sets a per-device font that overrides the fit until "Reset view".
 */
import type { Session } from '../lib/contracts'

export const BASE_FONT = 13
export const MAX_FONT = 32
const ZOOM_KEY = 'bakin-terminal-font'

export type ScreenDevice = 'desktop' | 'phone'

/** Touch screens get a larger floor: below 10px a phone grid is unreadable. */
export function minFont(view: Pick<Window, 'matchMedia'> = window): number {
  return view.matchMedia('(pointer: coarse)').matches ? 10 : 8
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

/** This device's pinched font, if any. Storage can be absent (private mode, blocked site data). */
export function storedFont(storage: () => Storage = () => window.localStorage): number | undefined {
  try {
    const value = Number(storage().getItem(ZOOM_KEY))
    return Number.isFinite(value) && value >= 6 && value <= MAX_FONT ? value : undefined
  } catch {
    // No storage: the view just isn't remembered.
    return undefined
  }
}

export function storeFont(size: number | undefined, storage: () => Storage = () => window.localStorage): void {
  try {
    if (size === undefined) storage().removeItem(ZOOM_KEY)
    else storage().setItem(ZOOM_KEY, String(size))
  } catch {
    // No storage: the pinch still applies for this page, it just isn't remembered.
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
