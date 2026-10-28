import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The phone editing session (spec D9 item 9). The key bar shows while the
 * operator is typing, not by measuring the keyboard: WebKit offers no
 * keyboard API, and Safari 26's floating toolbar defeats viewport
 * heuristics. `sheet` is the ••• key sheet standing in for the keyboard.
 */
export type EditingSession = 'idle' | 'typing' | 'sheet'
export type SessionEvent =
  /** The terminal's input took focus (a tap on the terminal, the keyboard button, abc). */
  | 'focus-input'
  /** Focus moved inside the bar or the sheet. */
  | 'focus-keys'
  /** Focus went nowhere: the system dismissed the keyboard, or the sheet took its place. */
  | 'focus-lost'
  /** Focus moved to something else on the page. */
  | 'focus-outside'
  | 'open-sheet' | 'abc' | 'hide'

export function nextSession(state: EditingSession, event: SessionEvent): EditingSession {
  switch (event) {
    case 'focus-input': case 'abc': return 'typing'
    case 'open-sheet': return 'sheet'
    case 'hide': case 'focus-outside': return 'idle'
    case 'focus-lost': return state === 'sheet' ? 'sheet' : 'idle'
    case 'focus-keys': return state
  }
}

/** The terminal's own input element (xterm's helper textarea). */
export const isTerminalInput = (element: Element | null): boolean => element?.classList.contains('xterm-helper-textarea') ?? false
/** The bar, the sheet, and anything portalled from them. */
export const isTerminalKeys = (element: Element | null): boolean => Boolean(element?.closest('[data-terminal-keys]'))

/** Track the session from focus; `enabled` is false off touch screens and without a live session. */
export function useEditingSession(enabled: boolean): [EditingSession, (event: SessionEvent) => void] {
  const [session, setSession] = useState<EditingSession>('idle')
  const dispatch = useCallback((event: SessionEvent) => setSession(state => nextSession(state, event)), [])
  const lost = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!enabled) { setSession('idle'); return }
    const focusIn = (event: FocusEvent) => {
      clearTimeout(lost.current)
      const target = event.target instanceof Element ? event.target : null
      dispatch(isTerminalInput(target) ? 'focus-input' : isTerminalKeys(target) ? 'focus-keys' : 'focus-outside')
    }
    // Focus leaving to nothing settles after the event: a tap on a key or a
    // remount may refocus at once. Only a lasting loss ends the session.
    const focusOut = () => {
      clearTimeout(lost.current)
      lost.current = setTimeout(() => {
        const active = document.activeElement
        if (!active || active === document.body) dispatch('focus-lost')
      }, 120)
    }
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', focusOut)
    if (isTerminalInput(document.activeElement)) dispatch('focus-input')
    return () => {
      clearTimeout(lost.current)
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
    }
  }, [enabled, dispatch])
  return [session, dispatch]
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
