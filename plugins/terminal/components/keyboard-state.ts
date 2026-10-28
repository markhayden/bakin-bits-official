import { useEffect, useState } from 'react'

/**
 * Whether the on-screen keyboard is up, for the key bar (spec D9 item 9).
 * There is no browser API that says so; this is a heuristic over the visual
 * viewport. The workspace already bounds the page to that viewport, which is
 * what places the bar above the keyboard; this only decides whether to show it.
 */
export interface ViewportSample { layoutHeight: number; visualHeight: number; visualTop: number; scale: number }

/** Shown once the keyboard covers this much of the screen; hidden again below the lower mark. */
export const KEYBOARD_SHOWN_PX = 150
export const KEYBOARD_HIDDEN_PX = 80

/** The height of the strip below the visual viewport (the keyboard, when it is up). */
export function occluded(sample: ViewportSample): number {
  return Math.max(0, sample.layoutHeight - (sample.visualTop + sample.visualHeight))
}

export function keyboardUp(previous: boolean, sample: ViewportSample | undefined, focused: boolean): boolean {
  if (!focused) return false
  // No measurement available: the terminal has focus on a touch screen, so a keyboard is likely.
  if (!sample) return true
  // Pinch zoom shrinks the visual viewport too; such a sample says nothing about the keyboard.
  if (Math.abs(sample.scale - 1) > 0.01) return previous
  return occluded(sample) > (previous ? KEYBOARD_HIDDEN_PX : KEYBOARD_SHOWN_PX)
}

/** True while `focusTarget` (the terminal's input) has focus and the keyboard is judged up. */
export function useKeyboardUp(enabled: boolean, isFocusTarget: (element: Element | null) => boolean): boolean {
  const [up, setUp] = useState(false)
  useEffect(() => {
    if (!enabled) { setUp(false); return }
    const viewport = window.visualViewport
    let frame = 0
    let blur: ReturnType<typeof setTimeout> | undefined
    const sample = (): ViewportSample | undefined => viewport
      ? { layoutHeight: window.innerHeight, visualHeight: viewport.height, visualTop: viewport.offsetTop, scale: viewport.scale }
      : undefined
    const measure = () => { frame = 0; setUp(previous => keyboardUp(previous, sample(), isFocusTarget(document.activeElement))) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    // Focus moves briefly during some taps; let it settle before hiding the bar.
    const focusOut = () => { clearTimeout(blur); blur = setTimeout(schedule, 150) }
    const focusIn = () => { clearTimeout(blur); schedule() }
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', focusOut)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(blur)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
    }
  }, [enabled, isFocusTarget])
  return up
}

/** A touch screen (the primary pointer is coarse): the only devices that get a key bar. */
export function useCoarsePointer(): boolean {
  const query = '(pointer: coarse)'
  const [coarse, setCoarse] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia(query)
    const change = () => setCoarse(media.matches)
    media.addEventListener('change', change)
    change()
    return () => media.removeEventListener('change', change)
  }, [])
  return coarse
}

/** The terminal's own input element (xterm's helper textarea). */
export const isTerminalInput = (element: Element | null): boolean => element?.classList.contains('xterm-helper-textarea') ?? false
