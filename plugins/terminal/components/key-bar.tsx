import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@makinbakin/sdk/ui'
import { ComposeSheet } from './compose-sheet'
import { Joystick } from './joystick'
import { CONTROL_LABELS, CONTROL_SHORTCUTS, keyFace, SHEET_KEYS, type ArrowKey, type Modifier, type ModifierState, type TerminalKey } from './terminal-input'
import type { EditingSession } from './editing-session'

const MODIFIER_NAMES: Record<Modifier, string> = { ctrl: 'Control', alt: 'Option' }
const MODIFIER_FACES: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥' }

function modifierLabel(modifier: Modifier, state: ModifierState[Modifier]): string {
  const name = MODIFIER_NAMES[modifier]
  return state === 'locked' ? `${name}, locked` : state === 'once' ? `${name}, on for the next key` : name
}

// Keys keep focus where it is: the terminal's input keeps the keyboard up.
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

function Keycap({ label, face, tone, state, disabled, className, onPress, onKeyDown }: {
  label: string; face: React.ReactNode; tone?: 'function'; state?: ModifierState[Modifier]
  disabled?: boolean; className?: string; onPress(event: React.MouseEvent): void; onKeyDown?(event: React.KeyboardEvent): void
}) {
  // The kit Button (focus ring, disabled state, activation), drawn as a keycap by the plugin's scoped CSS.
  return <Button variant="ghost" size="icon-lg" className={`terminal-keycap${className ? ' ' + className : ''}`} data-tone={tone} data-state={state}
    aria-label={label} aria-pressed={state === undefined ? undefined : state !== 'off'} disabled={disabled}
    onMouseDown={keepFocus} onClick={onPress} onKeyDown={onKeyDown}>{face}</Button>
}

const ARROWS_ICON = <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l3.2 4.2H8.8z" /><path d="M12 21.5l-3.2-4.2h6.4z" /><path d="M2.5 12l4.2-3.2v6.4z" /><path d="M21.5 12l-4.2 3.2V8.8z" /><circle cx="12" cy="12" r="2" /></svg>
const ARROW_KEYS: Record<string, ArrowKey> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

/**
 * The arrow joystick: press and drag to send arrows (repeating while held),
 * or tap an edge for one step. With keyboard focus, the arrow keys send
 * arrows. The sheet keeps the four ordinary arrow buttons (VoiceOver).
 */
function ArrowJoystick({ disabled, onArrow }: { disabled: boolean; onArrow(key: ArrowKey): void }) {
  const send = useRef(onArrow)
  send.current = onArrow
  const stick = useRef<Joystick | null>(null)
  stick.current ??= new Joystick((key) => send.current(key))
  const pointer = useRef<number | undefined>(undefined)
  // Disabled or gone: stop any repeat at once.
  useEffect(() => { if (disabled) stick.current?.cancel() }, [disabled])
  useEffect(() => () => stick.current?.cancel(), [])
  const mine = (event: React.PointerEvent) => event.pointerId === pointer.current
  return <Button variant="ghost" size="icon-lg" className="terminal-keycap terminal-joystick" aria-label="Arrow keys" disabled={disabled}
    onMouseDown={keepFocus}
    onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled || event.button !== 0 || pointer.current !== undefined) return
      pointer.current = event.pointerId
      event.currentTarget.setPointerCapture?.(event.pointerId)
      stick.current!.start(event.clientX, event.clientY)
    }}
    onPointerMove={(event: React.PointerEvent<HTMLButtonElement>) => { if (mine(event)) stick.current!.move(event.clientX, event.clientY) }}
    onPointerUp={(event: React.PointerEvent<HTMLButtonElement>) => {
      if (!mine(event)) return
      pointer.current = undefined
      const box = event.currentTarget.getBoundingClientRect()
      stick.current!.end(event.clientX - box.left, event.clientY - box.top, box.width, box.height)
    }}
    onPointerCancel={(event: React.PointerEvent<HTMLButtonElement>) => { if (mine(event)) { pointer.current = undefined; stick.current!.cancel() } }}
    onLostPointerCapture={(event: React.PointerEvent<HTMLButtonElement>) => { if (mine(event)) { pointer.current = undefined; stick.current!.cancel() } }}
    // Pointer presses are handled above; the click that follows them sends nothing.
    onClick={(event: React.MouseEvent) => event.preventDefault()}
    onKeyDown={(event: React.KeyboardEvent) => {
      const key = ARROW_KEYS[event.key]
      if (!key || disabled) return
      event.preventDefault()
      event.stopPropagation()
      send.current(key)
    }}>{ARROWS_ICON}</Button>
}

const HIDE_ICON = <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="11" rx="2" /><path d="M6 7.5h.01M9.5 7.5h.01M13 7.5h.01M16.5 7.5h.01M7 11.5h10" /><path d="M9 18.5l3 2.5 3-2.5" /></svg>
const MORE_ICON = <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>

/**
 * The phone key bar (spec D9 item 9, v2): one row of iOS-style keycaps shown
 * while the operator is typing, and the ••• key sheet that stands in for the
 * keyboard. `data-terminal-keys` marks both as part of the terminal, so
 * touching them neither ends the editing session nor drops a modifier.
 * Hide keyboard works even while sending is disabled.
 */
export function KeyBar({ sessionId, session, disabled, modifiers, onKey, onModifier, onSheet, onCompose, onPaste, onKeyboard, onHide }: {
  sessionId: string; session: Exclude<EditingSession, 'idle'>; disabled: boolean; modifiers: ModifierState
  onKey(key: TerminalKey): void
  onModifier(modifier: Modifier, action: 'tap' | 'lock'): void
  /** Open the key sheet (the keyboard goes down). */
  onSheet(): void
  /** Open the compose sheet (its textarea takes the keyboard within this tap). */
  onCompose(): void
  /** Send compose text as a paste; true once it went. */
  onPaste(text: string, enter: boolean): boolean
  /** Back to the keyboard from the sheet (focuses the terminal within this tap). */
  onKeyboard(): void
  onHide(): void
}) {
  const sheet = useRef<HTMLDivElement>(null)
  const compose = useRef<HTMLTextAreaElement>(null)
  // Rendered and focused within the tap, so a phone raises the keyboard for the textarea.
  const openCompose = () => {
    flushSync(onCompose)
    compose.current?.focus()
  }
  const sheetOpen = session === 'sheet' || session === 'compose'
  const modifierKey = (modifier: Modifier) => <Keycap key={modifier} label={modifierLabel(modifier, modifiers[modifier])} face={<>{MODIFIER_FACES[modifier]}{modifiers[modifier] === 'locked' && <span className="terminal-keycap-lock" aria-hidden="true" />}</>}
    state={modifiers[modifier]} disabled={disabled} onPress={() => onModifier(modifier, 'tap')} />
  const sendKey = (key: TerminalKey, label?: string) => <Keycap key={key} label={label ? `${key} ${label}` : key}
    face={label ? <><span className="terminal-keycap-face">{keyFace(key)}</span><span className="terminal-keycap-label">{label}</span></> : keyFace(key)}
    className={label ? 'terminal-keycap-wide' : undefined} disabled={disabled} onPress={() => onKey(key)} />
  const openSheet = (event: React.MouseEvent) => {
    onSheet()
    // Opened from a keyboard (no pointer), focus moves into the sheet: its
    // first usable key, or the sheet itself while sending is disabled.
    if (event.detail === 0) requestAnimationFrame(() => (sheet.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? sheet.current)?.focus())
  }
  // Escape anywhere in the bar or a sheet goes back to the keyboard while one is open.
  const escape = (event: React.KeyboardEvent) => { if (sheetOpen && event.key === 'Escape') { event.preventDefault(); onKeyboard() } }
  return <div className="terminal-key-accessory" data-terminal-keys="" onKeyDown={escape}>
    <div role="group" aria-label="Terminal keys" className="terminal-key-bar">
      {sendKey('Esc')}
      {sendKey('Tab')}
      {modifierKey('ctrl')}
      {modifierKey('alt')}
      <ArrowJoystick disabled={disabled} onArrow={onKey} />
      {sheetOpen
        ? <Keycap label="Back to keyboard" face="abc" tone="function" className="terminal-key-push" onPress={onKeyboard} />
        : <Keycap label="More keys" face={MORE_ICON} tone="function" className="terminal-key-push" onPress={openSheet} />}
      <span aria-hidden="true" className="terminal-key-divider" />
      <Keycap label="Hide keyboard" face={HIDE_ICON} tone="function" className="terminal-keycap-hide" onPress={onHide} />
    </div>
    {session === 'compose' && <ComposeSheet sessionId={sessionId} disabled={disabled} textarea={compose} onSend={onPaste} />}
    {session === 'sheet' && <div ref={sheet} role="region" aria-label="More keys" tabIndex={-1} className="terminal-key-sheet">
      <div role="group" aria-label="Text" className="terminal-key-grid terminal-key-grid-labelled">
        <Keycap label="Compose" face={<><span className="terminal-keycap-face">✎</span><span className="terminal-keycap-label">Compose</span></>}
          className="terminal-keycap-wide" onPress={openCompose} />
      </div>
      <div role="group" aria-label="Keys" className="terminal-key-grid">{SHEET_KEYS.map(key => sendKey(key))}</div>
      <div role="group" aria-label="Control" className="terminal-key-grid terminal-key-grid-labelled">{CONTROL_SHORTCUTS.map(key => sendKey(`Ctrl+${key}`, CONTROL_LABELS[key]))}</div>
      <div role="group" aria-label="Locks" className="terminal-key-grid terminal-key-grid-labelled">
        {(['ctrl', 'alt'] as const).map(modifier => <Keycap key={modifier} label={`${MODIFIER_NAMES[modifier]} lock`}
          face={<><span className="terminal-keycap-face">{MODIFIER_FACES[modifier]}</span><span className="terminal-keycap-label">{MODIFIER_NAMES[modifier]} lock</span></>}
          className="terminal-keycap-wide" state={modifiers[modifier] === 'locked' ? 'locked' : 'off'} disabled={disabled}
          onPress={() => onModifier(modifier, modifiers[modifier] === 'locked' ? 'tap' : 'lock')} />)}
      </div>
    </div>}
  </div>
}
