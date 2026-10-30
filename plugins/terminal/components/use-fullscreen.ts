import { useCallback, useEffect, useState } from 'react'

/**
 * Full screen for the terminal (Mark, 2026-10-29): the browser's own full
 * screen on the terminal's page, so the browser's UI and Bakin's sidebar
 * and top bar go and the terminal fills the display. Where the browser
 * cannot (an iPhone's Safari has no element full screen), `supported` is
 * false and nothing is offered. While full screen, Escape is claimed where
 * the browser allows it (Keyboard Lock): Esc is a terminal key (Claude
 * Code, vim), and holding it still leaves full screen.
 */
type KeyboardLock = { lock?(keys?: string[]): Promise<void>; unlock?(): void }

export function useFullscreen(target: () => HTMLElement | null): { supported: boolean; active: boolean; toggle(): void } {
  const supported = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled)
  const [active, setActive] = useState(() => typeof document !== 'undefined' && Boolean(document.fullscreenElement))
  useEffect(() => {
    if (!supported) return
    const changed = () => {
      const on = Boolean(document.fullscreenElement)
      setActive(on)
      const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard
      if (on) void keyboard?.lock?.(['Escape']).catch(() => undefined)
      else keyboard?.unlock?.()
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [supported])
  // Leaving the terminal (another page, another session) leaves full screen too.
  useEffect(() => () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined) }, [])
  const toggle = useCallback(() => {
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return }
    const element = target()
    if (element) void element.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined)
  }, [target])
  return { supported, active, toggle }
}
