import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, RotateCw } from 'lucide-react'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { ListRow, ListRowGroup, ListRows } from '@makinbakin/sdk/patterns'
import { Alert, AlertDescription, Button, FormActions, Input, Skeleton, Switch, Text } from '@makinbakin/sdk/ui'
import type { DirectoryListing } from '../lib/directories'
import { terminalFetch } from './api'

type Listing = DirectoryListing & { recent: string[] }
/** One navigation: where to (none = home), and its attempt (a retry of the same place asks again). */
interface Request { path?: string; attempt: number }

async function list(path: string | undefined, hidden: boolean, filter: string): Promise<Listing> {
  const query = new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: '1' } : {}), ...(filter.trim() ? { filter: filter.trim() } : {}) })
  const response = await terminalFetch(`/directories?${query}`)
  const data = await response.json() as Listing & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Folders could not be listed (${response.status})`)
  return data
}

/** Filtering waits this long after typing stops (the server filters before its cap). */
const FILTER_WAIT_MS = 200

/**
 * The New terminal folder picker (inside its dialog): this Mac's folders,
 * browsed by whole-row activation (lists/list-rows.stories.tsx —
 * InteractiveRows), recent session folders first. A browser's own picker
 * cannot name a folder on the server (and on a phone browses the phone).
 * "Use this folder" takes the folder shown, and waits while another loads.
 */
export function FolderPicker({ start, onChoose, onCancel }: { start: string; onChoose(path: string): void; onCancel(): void }) {
  const [listing, setListing] = useState<Listing>()
  // `error`: the request shown failed (Retry asks it again). `notice`: why the picker is not where it was asked to start.
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('')
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState(false)
  const [request, setRequest] = useState<Request>({ path: start.trim() || undefined, attempt: 0 })
  const [loading, setLoading] = useState(true)
  const loaded = useRef(false)
  const navigate = (path: string | undefined) => { setNotice(''); setFilter(''); setQuery(''); setRequest((last) => ({ path, attempt: last.attempt + 1 })) }
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filter), FILTER_WAIT_MS)
    return () => clearTimeout(timer)
  }, [filter])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    list(request.path, hidden, query).then((next) => {
      if (cancelled) return
      setError('')
      loaded.current = true
      setListing(next)
      setLoading(false)
    }, (reason: unknown) => {
      if (cancelled) return
      const message = reason instanceof Error ? reason.message : String(reason)
      // A typed path that is not a folder yet: start from home instead, saying why (that is not this request's error).
      if (!loaded.current && request.path) { setNotice(`${message} Showing your home folder.`); setRequest((last) => ({ path: undefined, attempt: last.attempt + 1 })); return }
      setError(message)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [request, hidden, query])
  const recent = listing?.recent.filter((path) => path !== listing.path) ?? []
  const choosable = listing && !loading
  return <Stack gap="item">
    {notice && <Alert tone="info"><AlertDescription>{notice}</AlertDescription></Alert>}
    {error && <Alert tone="attention"><AlertDescription>
      <Inline gap="dense" wrap className="items-center justify-between"><span>{error}</span>
        {!loading && <Button type="button" size="sm" variant="outline" onClick={() => setRequest((last) => ({ ...last, attempt: last.attempt + 1 }))}><RotateCw size={16} />Retry</Button>}
      </Inline>
    </AlertDescription></Alert>}
    <Inline gap="dense" wrap={false} className="items-center">
      <Button type="button" size="icon-sm" variant="outline" aria-label="Up to the parent folder" disabled={!listing?.parent || loading} onClick={() => navigate(listing?.parent)}><ArrowUp size={16} /></Button>
      <Text size="meta" mono className="min-w-0 break-all" aria-live="polite">{loading ? 'Loading…' : listing?.path ?? ''}</Text>
    </Inline>
    <Input aria-label="Filter folders" placeholder="Filter folders" value={filter} disabled={!listing} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)} />
    {!listing ? loading && <Stack gap="dense" aria-label="Loading folders"><Skeleton className="h-bakin-8" /><Skeleton className="h-bakin-8" /><Skeleton className="h-bakin-8" /></Stack> : <>
      {recent.length > 0 && !query && <ListRowGroup label="Recent">
        <ListRows variant="separated" size="sm" aria-label="Recent">
          {recent.map((path) => <ListRow key={path} interactive={{ label: `Open ${path}`, onActivate: () => navigate(path) }} className="flex min-w-0 items-center gap-bakin-2"><Folder size={16} aria-hidden /><Text size="meta" mono className="min-w-0 truncate">{path}</Text></ListRow>)}
        </ListRows>
      </ListRowGroup>}
      <ListRowGroup label={query ? 'Matching folders' : 'Folders'}>
        {listing.entries.length ? <ListRows variant="separated" size="sm" aria-label="Folders">
          {listing.entries.map((entry) => <ListRow key={entry.path} interactive={{ label: `Open ${entry.name}`, onActivate: () => navigate(entry.path) }} className="flex min-w-0 items-center gap-bakin-2"><Folder size={16} aria-hidden /><span className="min-w-0 truncate">{entry.name}</span></ListRow>)}
        </ListRows> : <Text size="meta" tone="muted">{query ? 'No folder here matches.' : 'No folders here.'}</Text>}
      </ListRowGroup>
      {listing.truncated === 'limit' && <Text size="meta" tone="muted">Showing the first {listing.entries.length} folders; filter to narrow them.</Text>}
      {listing.truncated === 'scan' && <Text size="meta" tone="muted">This folder is too large to list completely; type the path you want in the working directory instead.</Text>}
    </>}
    <label className="flex items-center gap-bakin-2"><Switch checked={hidden} onCheckedChange={(on: boolean) => setHidden(on)} aria-label="Show hidden folders" /><Text size="meta">Show hidden folders</Text></label>
    {/* The choice repeated beside its action: a long list scrolls the path out of view. */}
    {choosable && <Text size="meta" tone="muted" mono className="break-all">Uses {listing.path}</Text>}
    <FormActions>
      <Button type="button" variant="outline" onClick={onCancel}>Back</Button>
      <Button type="button" disabled={!choosable} onClick={() => { if (listing && !loading) onChoose(listing.path) }}>Use this folder</Button>
    </FormActions>
  </Stack>
}
