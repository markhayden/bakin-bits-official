import { useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ellipsis } from 'lucide-react'
import { Stack } from '@makinbakin/sdk/layout'
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Text } from '@makinbakin/sdk/ui'
import { CONTROL_LABELS, CONTROL_SHORTCUTS, keyFace, MENU_KEYS, type ArrowKey, type TerminalKey } from './terminal-input'

const ARROW_ICONS = { Up: ArrowUp, Down: ArrowDown, Left: ArrowLeft, Right: ArrowRight } as const

/**
 * The phone key bar (spec D9 item 9): shown by the page only while the
 * on-screen keyboard is up. A sideways-scrolling strip (Esc, Tab, latching
 * Ctrl, one arrow key, then pinned keys) and a fixed ••• menu with every
 * other key. Every key keeps focus on the terminal, so the keyboard stays up,
 * and one activation sends exactly one key. `data-terminal-keys` marks the
 * bar and its portalled menu as part of the terminal: touching them does not
 * drop the Ctrl latch.
 */
export function KeyBar({ disabled, ctrl, onCtrl, onKey, onFocusTerminal, arrow, pins }: {
  disabled: boolean; ctrl: boolean; onCtrl(): void; onKey(key: TerminalKey): void
  /** Put focus back on the terminal's input (the menu closing hands it back there, never to •••). */
  onFocusTerminal(): void
  /** The arrow key's face: the direction a tap sends. */
  arrow: ArrowKey
  pins: readonly TerminalKey[]
}) {
  const [menu, setMenu] = useState(false)
  const preserveFocus = (event: React.MouseEvent) => event.preventDefault()
  // Opened by touch, the menu leaves focus on the terminal (moving it would
  // drop the keyboard); closing always hands focus back to the terminal.
  const openFocus = (type: string) => type !== 'touch'
  const closeFocus = () => { onFocusTerminal(); return false }
  const ArrowIcon = ARROW_ICONS[arrow]
  const stripKey = (key: TerminalKey, className = '') => <Button key={key} size="lg" variant="outline" aria-label={key} className={className} disabled={disabled} onMouseDown={preserveFocus} onClick={() => onKey(key)}>{keyFace(key)}</Button>
  const menuKey = (key: TerminalKey, label?: string) => <Button key={key} variant="outline" aria-label={label ? `${key} ${label}` : key} disabled={disabled} onMouseDown={preserveFocus} onClick={() => { onKey(key); setMenu(false) }} className={label ? 'justify-start' : undefined}>
    <Text as="span" mono>{keyFace(key)}</Text>{label && <Text as="span" tone="muted" weight="regular">{label}</Text>}
  </Button>
  // A keypad, not a page layout: fixed columns (portalled, so styled inline
  // rather than by the plugin stylesheet).
  const keypad = (columns: number) => ({ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 'var(--bakin-layout-space-2)' })
  const group = (name: string, columns: number, keys: React.ReactNode) => <Stack as="section" gap="dense" aria-label={name}>
    <Text as="h3" size="meta" tone="muted" weight="semibold" aria-hidden="true">{name}</Text>
    <div style={keypad(columns)}>{keys}</div>
  </Stack>
  return <div role="toolbar" aria-label="Terminal keys" data-terminal-keys="" className="terminal-key-bar">
    <div className="terminal-key-strip" data-terminal-keys="">
      {stripKey('Esc')}{stripKey('Tab')}
      <Button size="lg" variant={ctrl ? 'primary' : 'outline'} aria-pressed={ctrl} disabled={disabled} onMouseDown={preserveFocus} onClick={onCtrl}>Ctrl</Button>
      <Button size="icon-lg" variant="outline" aria-label={arrow} disabled={disabled} onMouseDown={preserveFocus} onClick={() => onKey(arrow)}><ArrowIcon aria-hidden="true" /></Button>
      <span aria-hidden="true" className="terminal-key-divider" />
      {pins.map(key => stripKey(key, 'terminal-key-pin'))}
    </div>
    <div className="terminal-key-more">
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger render={<Button size="icon-lg" variant={menu ? 'primary' : 'outline'} aria-label="More keys" onMouseDown={preserveFocus} />}><Ellipsis aria-hidden="true" /></PopoverTrigger>
        <PopoverContent side="top" align="end" initialFocus={openFocus} finalFocus={closeFocus} data-terminal-keys="">
          <PopoverTitle className="sr-only">More keys</PopoverTitle>
          {group('Keys', 4, MENU_KEYS.map(key => menuKey(key)))}
          {group('Control', 2, CONTROL_SHORTCUTS.map(key => menuKey(`Ctrl+${key}`, CONTROL_LABELS[key])))}
        </PopoverContent>
      </Popover>
    </div>
  </div>
}
