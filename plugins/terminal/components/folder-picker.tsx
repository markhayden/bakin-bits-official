import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder } from 'lucide-react'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { ListRow, ListRowGroup, ListRows } from '@makinbakin/sdk/patterns'
import { Alert, AlertDescription, Button, FormActions, Input, Skeleton, Switch, Text } from '@makinbakin/sdk/ui'
import type { DirectoryListing } from '../lib/directories'
import { terminalFetch } from './api'

type Listing = DirectoryListing & { recent: string[] }

async function list(path: string | undefined, hidden: boolean): Promise<Listing> {
  const query = new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: '1' } : {}) })
  const response = await terminalFetch(`/directories?${query}`)
  const data = await response.json() as Listing & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Folders could not be listed (${response.status})`)
  return data
}

/**
 * The New terminal folder picker (inside its dialog): this Mac's folders,
 * browsed by whole-row activation (lists/list-rows.stories.tsx —
 * InteractiveRows), recent session folders first. A browser's own picker
 * cannot name a folder on the server (and on a phone browses the phone).
 */
export function FolderPicker({ start, onChoose, onCancel }: { start: string; onChoose(path: string): void; onCancel(): void }) {
  const [listing, setListing] = useState<Listing>()
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [hidden, setHidden] = useState(false)
  const [target, setTarget] = useState<string | undefined>(start.trim() || undefined)
  const loaded = useRef(false)
  useEffect(() => {
    let cancelled = false
    list(target, hidden).then((next) => {
      if (cancelled) return
      // The fallback from a typed path keeps saying why it is somewhere else.
      if (loaded.current) setError('')
      loaded.current = true
      setListing(next); setFilter('')
    }, (reason: unknown) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason))
      // A typed path that is not a folder yet: start from home instead, saying why.
      if (!loaded.current && target) setTarget(undefined)
    })
    return () => { cancelled = true }
  }, [target, hidden])
  const shown = listing?.entries.filter((entry) => entry.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  const recent = listing?.recent.filter((path) => path !== listing.path) ?? []
  return <Stack gap="item">
    {error && <Alert tone="attention"><AlertDescription>{error}</AlertDescription></Alert>}
    <Inline gap="dense" wrap={false} className="items-center">
      <Button type="button" size="icon-sm" variant="outline" aria-label="Up to the parent folder" disabled={!listing?.parent} onClick={() => setTarget(listing?.parent)}><ArrowUp size={16} /></Button>
      <Text size="meta" mono className="min-w-0 break-all" aria-live="polite">{listing?.path ?? 'Loading…'}</Text>
    </Inline>
    <Input aria-label="Filter folders" placeholder="Filter folders" value={filter} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)} />
    {!listing ? <Stack gap="dense"><Skeleton className="h-bakin-8" /><Skeleton className="h-bakin-8" /><Skeleton className="h-bakin-8" /></Stack> : <>
      {recent.length > 0 && !filter && <ListRowGroup label="Recent">
        <ListRows variant="separated" size="sm" aria-label="Recent">
          {recent.map((path) => <ListRow key={path} interactive={{ label: `Open ${path}`, onActivate: () => setTarget(path) }} className="flex min-w-0 items-center gap-bakin-2"><Folder size={16} aria-hidden /><Text size="meta" mono className="min-w-0 truncate">{path}</Text></ListRow>)}
        </ListRows>
      </ListRowGroup>}
      <ListRowGroup label={filter ? 'Matching folders' : 'Folders'}>
        {shown.length ? <ListRows variant="separated" size="sm" aria-label="Folders">
          {shown.map((entry) => <ListRow key={entry.path} interactive={{ label: `Open ${entry.name}`, onActivate: () => setTarget(entry.path) }} className="flex min-w-0 items-center gap-bakin-2"><Folder size={16} aria-hidden /><span className="min-w-0 truncate">{entry.name}</span></ListRow>)}
        </ListRows> : <Text size="meta" tone="muted">{filter ? 'No folder here matches.' : 'No folders here.'}</Text>}
      </ListRowGroup>
      {listing.truncated && <Text size="meta" tone="muted">Showing the first {listing.entries.length} folders; filter to narrow them.</Text>}
    </>}
    <label className="flex items-center gap-bakin-2"><Switch checked={hidden} onCheckedChange={(on: boolean) => setHidden(on)} aria-label="Show hidden folders" /><Text size="meta">Show hidden folders</Text></label>
    <FormActions>
      <Button type="button" variant="outline" onClick={onCancel}>Back</Button>
      <Button type="button" disabled={!listing} onClick={() => { if (listing) onChoose(listing.path) }}>Use this folder</Button>
    </FormActions>
  </Stack>
}
