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

/** Below the visual viewport, this much covered screen means an on-screen keyboard is up. */
export const SOFT_KEYBOARD_PX = 150

/**
 * Whether Enter from the terminal's input should put the keyboard away
 * (Mark, 2026-10-28: after sending, the response needs the screen). Only the
 * on-screen keyboard: a hardware keyboard would lose focus for nothing.
 * Android's on-screen keyboards leave KeyboardEvent.code empty; iOS reports
 * "Enter", so there a visibly covered screen says one is up. When neither
 * tells (a floating keyboard, a zoomed page) the keyboard simply stays.
 */
export function enterHidesKeyboard(event: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'isComposing' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>, covered: number | undefined, line: { continued: boolean; modified: boolean }): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
  // A new line, not a send: `\` + Return, or Return with the bar's ⌃/⌥ (Option+Return in Claude Code).
  if (line.continued || line.modified) return false
  return event.code === '' || (covered !== undefined && covered > SOFT_KEYBOARD_PX)
}

/**
 * The last character of what the operator has typed on the current line, as
 * far as it can be told from what was sent: bracketed-paste markers are
 * stripped, terminal replies and other escape sequences leave it as it was,
 * and a deletion makes it unknown. Feeds the `\` + Return continuation check.
 */
export function lineTail(previous: string, sent: string): string {
  const open = '\x1b[200~', close = '\x1b[201~'
  const paste = sent.startsWith(open) && sent.endsWith(close)
  const text = paste ? sent.slice(open.length, -close.length) : sent
  if (!paste && text.startsWith('\x1b')) return previous
  if (text.includes('\x7f') || text.includes('\b')) return ''
  return text ? text.at(-1)! : previous
}

/** How much of the layout viewport the visual viewport leaves covered at the bottom (an on-screen keyboard). */
export function coveredByKeyboard(): number | undefined {
  const viewport = typeof window === 'undefined' ? undefined : window.visualViewport
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return undefined
  return Math.max(0, window.innerHeight - (viewport.offsetTop + viewport.height))
}

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

/**
 * Enter on the on-screen keyboard sends the line, then `hide` puts the
 * keyboard away. `line()` says whether this Return continues the line
 * instead (the last thing sent ended in `\`, or a bar modifier is on).
 */
export function useEnterHidesKeyboard(enabled: boolean, hide: () => void, line: () => { continued: boolean; modified: boolean }) {
  const latest = useRef({ hide, line })
  latest.current = { hide, line }
  useEffect(() => {
    if (!enabled) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const keydown = (event: KeyboardEvent) => {
      if (!isTerminalInput(event.target instanceof Element ? event.target : null)) return
      // Before xterm handles the key (capture): the line and modifiers are as they were.
      if (!enterHidesKeyboard(event, coveredByKeyboard(), latest.current.line())) return
      // After xterm has sent the Enter in this same event.
      clearTimeout(pending)
      pending = setTimeout(() => latest.current.hide(), 0)
    }
    document.addEventListener('keydown', keydown, true)
    return () => { clearTimeout(pending); document.removeEventListener('keydown', keydown, true) }
  }, [enabled])
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
