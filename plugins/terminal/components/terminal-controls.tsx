import { useId, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { Inline, Panel, Stack } from '@makinbakin/sdk/layout'
import { Button } from '@makinbakin/sdk/ui'
import { CONTROL_SHORTCUTS, EDITING_KEYS, type TerminalKey } from './terminal-input'

export function TerminalControls({ disabled, ctrl, onCtrl, onKey }: {
  disabled: boolean; ctrl: boolean; onCtrl(): void; onKey(key: TerminalKey): void
}) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const preserveFocus = (event: React.MouseEvent) => event.preventDefault()
  const keyButton = (key: TerminalKey) => <Button key={key} size="lg" variant="outline" disabled={disabled} onMouseDown={preserveFocus} onClick={() => onKey(key)}>{key}</Button>
  return <Stack role="group" aria-label="Terminal keys" gap="dense" className="terminal-input-controls border-t border-bakin-border-subtle bg-bakin-canvas-default p-bakin-3">
    {expanded && <Panel id={panelId} scroll padding="compact" aria-label="More terminal keys" className="max-h-[min(12rem,calc(var(--bakin-workspace-viewport-height,100dvh)*0.2))]">
      <Inline gap="dense">
        {EDITING_KEYS.map(keyButton)}
        {CONTROL_SHORTCUTS.map(key => keyButton(`Ctrl+${key}`))}
      </Inline>
    </Panel>}
    <Inline gap="dense" justify="between">
      <Inline gap="dense" role="group" aria-label="Modifiers and completion">
        {keyButton('Esc')}{keyButton('Tab')}
        <Button size="lg" variant={ctrl ? 'primary' : 'outline'} aria-pressed={ctrl} disabled={disabled} onMouseDown={preserveFocus} onClick={onCtrl}>Ctrl</Button>
        <Button size="lg" variant="outline" aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} onMouseDown={preserveFocus} onClick={() => setExpanded(value => !value)}>More</Button>
      </Inline>
      <Inline gap="dense" role="group" aria-label="Cursor keys">
        {([['Left', ArrowLeft], ['Down', ArrowDown], ['Up', ArrowUp], ['Right', ArrowRight]] as const).map(([key, Icon]) =>
          <Button key={key} size="icon-lg" variant="outline" aria-label={key} disabled={disabled} onMouseDown={preserveFocus} onClick={() => onKey(key)}><Icon aria-hidden="true" /></Button>)}
      </Inline>
    </Inline>
  </Stack>
}
