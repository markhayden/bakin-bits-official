import { useState } from 'react'
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Text } from '@makinbakin/sdk/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { SegmentedControl } from '@makinbakin/sdk/patterns'
import { Maximize2, Monitor, Ruler, Smartphone, Snowflake, SquareTerminal, Undo2 } from 'lucide-react'
import type { Session, SizeAuthority } from '../lib/contracts'
import { clientId } from './api'
import { MIN_FONTS, minFont, sizedBy, storeMinFont } from './terminal-view'

/** The kind of screen that sizes the session, as an icon: frozen, a phone, a desktop, a terminal app, or nobody yet. */
function SizeIcon({ authority, frozen }: { authority?: SizeAuthority; frozen: boolean }) {
  if (frozen) return <Snowflake size={16} />
  if (!authority) return <Ruler size={16} />
  if (authority.kind === 'native') return <SquareTerminal size={16} />
  return authority.device === 'phone' ? <Smartphone size={16} /> : <Monitor size={16} />
}

/**
 * The header's size control (spec D10): an icon for who sizes the grid,
 * with the grid beside it on wide screens. The popover says the rest: fit to
 * this device (always offered), go back to the screen that sized it before
 * the last handoff, and this device's smallest text for fitting someone else's grid.
 */
export function SizeControl({ session, frozen, busy, onFit, onRestore, onMinFont }: { session: Session; frozen: boolean; busy: boolean; onFit(): void; onRestore(): void; onMinFont(): void }) {
  const [floor, setFloor] = useState(() => String(minFont()))
  const me = clientId()
  const grid = `${session.cols}×${session.rows}`
  const by = sizedBy(session.sizeAuthority, me)
  const mine = by === 'this device'
  const line = frozen ? 'Size frozen' : by ? `Sized by ${by}` : 'Default size'
  // Going back to this device is fitting it, already offered; otherwise that screen (or app) sizes it again:
  // a connected one fits its own window, a disconnected one holds the grid it left.
  const back = session.previousSize && sizedBy(session.previousSize.authority, me)
  // Named for the negative: the SDK's stylesheet scan reads Bits sources, and a negated "running" token reads as a utility class.
  const ended = session.state !== 'running'
  return <Popover>
    <PopoverTrigger render={<Button size="sm" variant="ghost" aria-label={`Terminal size ${grid}, ${line.toLowerCase()}`} />}>
      <SizeIcon authority={session.sizeAuthority} frozen={frozen} />
      <span className="terminal-size-grid font-mono">{grid}</span>
      <span className="terminal-size-detail">· {line}</span>
    </PopoverTrigger>
    <PopoverContent align="end">
      <Stack gap="item">
        <PopoverTitle>{grid} · {line}</PopoverTitle>
        <Text size="meta" tone="muted">{frozen
          ? `The ${by ?? 'screen'} that sized this session is not connected, so the size holds until a screen fits it.`
          : mine ? 'This device sizes the session. Other screens fit the font to their width and pan.'
          : by ? `The ${by} sizes the session. This device fits the font to its width; pinch to zoom.`
          : 'Nobody has sized this session yet; it uses the default size for new sessions.'}</Text>
        <Button size="sm" disabled={busy || ended} onClick={onFit}><Maximize2 size={16} />Fit to this device</Button>
        {back && back !== 'this device' && <Button size="sm" variant="outline" disabled={busy || ended} onClick={onRestore}><Undo2 size={16} />Back to {back}</Button>}
        {!mine && <Stack gap="dense">
          <Text size="meta" tone="muted">Smallest text on this device</Text>
          <SegmentedControl size="sm" ariaLabel="Smallest text on this device" value={floor}
            onValueChange={(value: string) => { setFloor(value); storeMinFont(Number(value)); onMinFont() }}
            options={MIN_FONTS.map((size) => ({ value: String(size), label: `${size}px` }))} />
        </Stack>}
      </Stack>
    </PopoverContent>
  </Popover>
}
