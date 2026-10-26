import { useState } from 'react'
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Text } from '@makinbakin/sdk/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { SegmentedControl } from '@makinbakin/sdk/patterns'
import { Maximize2, Snowflake } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { clientId } from './api'
import { MIN_FONTS, minFont, sizedBy, storeMinFont } from './terminal-view'

/**
 * The header's size line (spec D10): the grid, who sizes it, and "Fit to
 * this device". Compact screens show the grid alone; the popover says the
 * rest, and sets this device's smallest text for fitting someone else's grid.
 */
export function SizeControl({ session, frozen, busy, onFit, onMinFont }: { session: Session; frozen: boolean; busy: boolean; onFit(): void; onMinFont(): void }) {
  const [floor, setFloor] = useState(() => String(minFont()))
  const grid = `${session.cols}×${session.rows}`
  const by = sizedBy(session, clientId())
  const mine = by === 'this device'
  const line = frozen ? 'Size frozen' : by ? `Sized by ${by}` : 'Default size'
  const running = session.state === 'running'
  return <Popover>
    <PopoverTrigger render={<Button size="sm" variant="ghost" aria-label={`Terminal size ${grid}, ${line.toLowerCase()}`} />}>
      {frozen && <Snowflake size={14} />}
      <span className="font-mono">{grid}</span>
      <span className="terminal-size-detail">· {line}</span>
    </PopoverTrigger>
    <PopoverContent align="end">
      <Stack gap="item">
        <PopoverTitle>{grid}</PopoverTitle>
        <Text size="meta" tone="muted">{frozen
          ? `The ${by ?? 'screen'} that sized this session is not connected, so the size holds until a screen fits it.`
          : mine ? 'This device sizes the session. Other screens fit the font to their width and pan.'
          : by ? `The ${by} sizes the session. This device fits the font to its width; pinch to zoom.`
          : 'Nobody has sized this session yet; it uses the default size for new sessions.'}</Text>
        <Button size="sm" disabled={busy || !running || mine} onClick={onFit}><Maximize2 size={16} />Fit to this device</Button>
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
