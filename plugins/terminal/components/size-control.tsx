import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Text } from '@makinbakin/sdk/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { Maximize2, Snowflake } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { clientId } from './api'
import { sizedBy } from './terminal-view'

/**
 * The header's size line (spec D10): the grid, who sizes it, and "Fit to
 * this device". Compact screens show the grid alone; the popover says the rest.
 */
export function SizeControl({ session, frozen, busy, onFit }: { session: Session; frozen: boolean; busy: boolean; onFit(): void }) {
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
      </Stack>
    </PopoverContent>
  </Popover>
}
