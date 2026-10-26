'use client'

/**
 * Files tab (D17): two groups — what the project's board tasks produced
 * (derived live by the server, never stored) and what was attached (attach,
 * relink, detach and preview through the SDK AssetPicker; the plugin owns
 * the collection data, the pattern owns the presentation).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { File, FileText, Film, Image, Link2, Music, Paperclip, X } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SystemState,
  Text,
  buttonVariants,
} from '@makinbakin/sdk/ui'
import { AssetPicker, ConfirmDialog, ListRow, ListRowActions, ListRows, StatusBadge } from '@makinbakin/sdk/patterns'
import type { AssetPickerCollection } from '@makinbakin/sdk/patterns'
import { PluginLink } from '@makinbakin/sdk/navigation'
import { projectRequest } from '../../lib/project-api'
import type { ProducedFile, ProjectDetailData, ResolvedProjectAsset as ResolvedAsset } from '../../types'

type AssetPickerMode = { type: 'attach' } | { type: 'relink'; target: ResolvedAsset }

const IMAGE_TYPES = new Set(['images', 'image'])
const VIDEO_TYPES = new Set(['video'])
const AUDIO_TYPES = new Set(['audio'])

const ASSET_ICONS: Record<string, typeof FileText> = {
  text: FileText,
  images: Image,
  video: Film,
  audio: Music,
}

function AssetIcon({ type }: { type: string }) {
  const Icon = ASSET_ICONS[type] || File
  return <Icon className="size-3.5 shrink-0 text-bakin-text-muted" />
}

function assetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`
}

function assetName(asset: ResolvedAsset): string {
  return asset.label || asset.assetId
}

function AssetThumb({ asset }: { asset: ResolvedAsset }) {
  const [err, setErr] = useState(false)
  if (IMAGE_TYPES.has(asset.type) && !asset.missing && !err) {
    return (
      <img
        src={assetUrl(asset.assetId)}
        alt={asset.assetId}
        onError={() => setErr(true)}
        className="size-bakin-8 rounded object-cover shrink-0 bg-bakin-surface-elevated"
      />
    )
  }
  return (
    <div className="size-bakin-8 rounded bg-bakin-surface-elevated flex items-center justify-center shrink-0">
      <AssetIcon type={asset.type} />
    </div>
  )
}

function AssetPreviewModal({ asset, onClose }: { asset: ResolvedAsset; onClose: () => void }) {
  const name = assetName(asset)
  const url = assetUrl(asset.assetId)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl" closeLabel="Close preview" data-testid="asset-preview">
        <DialogHeader>
          <DialogTitle className="truncate">{name}</DialogTitle>
          <DialogDescription>{asset.type}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 justify-center">
          {IMAGE_TYPES.has(asset.type) ? (
            <img src={url} alt={name} className="max-w-full rounded object-contain" />
          ) : VIDEO_TYPES.has(asset.type) ? (
            <video src={url} controls className="max-w-full rounded bg-bakin-canvas-default" />
          ) : AUDIO_TYPES.has(asset.type) ? (
            <audio src={url} controls className="w-full" />
          ) : (
            <div className="flex flex-col items-center gap-bakin-3 text-center">
              <div className="flex size-12 items-center justify-center rounded bg-bakin-surface-elevated">
                <AssetIcon type={asset.type} />
              </div>
              <Text size="meta" tone="muted">No inline preview for this asset type.</Text>
            </div>
          )}
        </div>
        <DialogFooter showCloseButton>
          <PluginLink to={`/assets/${encodeURIComponent(asset.assetId)}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Open asset</PluginLink>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ProducedState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; files: ProducedFile[] }

/** The derived "produced" group, refetched whenever the project changes. */
function useProducedFiles(projectId: string, version: string) {
  const [state, setState] = useState<ProducedState>({ status: 'loading' })
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    try {
      const data = await projectRequest(`${encodeURIComponent(projectId)}/files`) as { produced?: unknown }
      if (request !== generation.current) return
      if (!Array.isArray(data.produced)) throw new Error('Projects returned invalid file data.')
      setState({ status: 'ready', files: data.produced as ProducedFile[] })
    } catch (error) {
      if (request !== generation.current) return
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Produced files could not be loaded.' })
    }
  }, [projectId])
  useEffect(() => { void load() }, [load, version])
  return { state, retry: load }
}

export function FilesTab({ project, onChanged }: { project: ProjectDetailData; onChanged: () => Promise<unknown> }) {
  const produced = useProducedFiles(project.id, project.updated)
  const attachedIds = new Set(project.assets.map(asset => asset.assetId))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<AssetPickerMode>({ type: 'attach' })
  const [search, setSearch] = useState('')
  const [collection, setCollection] = useState<AssetPickerCollection>({ status: 'loading' })
  const [preview, setPreview] = useState<ResolvedAsset | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [detachTarget, setDetachTarget] = useState<ResolvedAsset | null>(null)
  const [detaching, setDetaching] = useState(false)
  const [detachError, setDetachError] = useState<string | null>(null)
  const projectPath = encodeURIComponent(project.id)

  const loadCollection = useCallback(async (mode: AssetPickerMode) => {
    setCollection({ status: 'loading' })
    try {
      const res = await fetch('/api/plugins/assets/versioned')
      if (!res.ok) throw new Error(`Asset library returned ${res.status}`)
      const data = await res.json()
      const attached = new Set(project.assets
        .filter(asset => mode.type !== 'relink' || asset.assetId !== mode.target.assetId)
        .map(asset => asset.assetId))
      setCollection({
        status: 'ready',
        assets: (data.assets || [])
          .filter((asset: { assetId: string }) => !attached.has(asset.assetId))
          .map((asset: { assetId: string; type: string; description?: string }) => ({
            id: asset.assetId,
            label: asset.assetId,
            description: asset.description,
            type: asset.type,
            thumbnailSrc: IMAGE_TYPES.has(asset.type) ? assetUrl(asset.assetId) : undefined,
          })),
      })
    } catch {
      setCollection({ status: 'error', message: 'The asset library is unavailable right now.' })
    }
  }, [project.assets])

  const openPicker = (mode: AssetPickerMode) => {
    setPickerMode(mode)
    setPickerError(null)
    setSearch('')
    setPickerOpen(true)
    void loadCollection(mode)
  }

  const pick = async (assetId: string) => {
    if (picking) return
    setPicking(true)
    setPickerError(null)
    try {
      if (pickerMode.type === 'relink') {
        await projectRequest(`${projectPath}/assets/${encodeURIComponent(pickerMode.target.assetId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newAssetId: assetId }),
        })
      } else {
        await projectRequest(`${projectPath}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId }),
        })
      }
      setPickerOpen(false)
      await onChanged()
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : 'The asset could not be saved. Try again.')
    } finally {
      setPicking(false)
    }
  }

  const detach = async (asset: ResolvedAsset) => {
    setDetaching(true)
    setDetachError(null)
    try {
      await projectRequest(`${projectPath}/assets/${encodeURIComponent(asset.assetId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setDetachTarget(null)
      await onChanged()
    } catch (error) {
      setDetachError(error instanceof Error ? error.message : 'The asset could not be detached. Try again.')
    } finally {
      setDetaching(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-bakin-6">
      <section aria-labelledby="project-produced-heading" className="flex min-w-0 flex-col gap-bakin-3">
        <h2 id="project-produced-heading">From this project's work</h2>
        {produced.state.status === 'loading' ? (
          <SystemState kind="loading" scope="inline" headingLevel={3} title="Loading produced files" />
        ) : produced.state.status === 'error' ? (
          <SystemState kind="error" recovery="available" scope="inline" headingLevel={3} title="Produced files could not be loaded" description={produced.state.message} action={<Button variant="outline" size="sm" onClick={() => { void produced.retry() }}>Try again</Button>} />
        ) : produced.state.files.filter(file => !attachedIds.has(file.assetId)).length === 0 ? (
          <SystemState kind="initial-empty" scope="inline" headingLevel={3} title="Nothing produced yet" description="Files the project's tasks create show up here." />
        ) : (
          <ListRows variant="separated" size="sm" aria-label="Produced files">
            {produced.state.files.filter(file => !attachedIds.has(file.assetId)).map(file => {
              const asset: ResolvedAsset = { assetId: file.assetId, type: file.type, ...(file.description ? { description: file.description } : {}) }
              return (
                <ListRow key={file.assetId} className="flex items-start gap-bakin-2" interactive={{ label: `Open ${file.description || file.assetId}`, onActivate: () => setPreview(asset) }}>
                  <AssetThumb asset={asset} />
                  <div className="min-w-0 flex-1">
                    <Text as="p" size="meta" className="truncate leading-tight">{file.description || file.assetId}</Text>
                    <Text as="p" size="meta" tone="muted" className="truncate">{file.type}</Text>
                  </div>
                </ListRow>
              )
            })}
          </ListRows>
        )}
      </section>

      <section aria-labelledby="project-files-heading" className="flex min-w-0 flex-col gap-bakin-3">
        <div className="flex flex-wrap items-center justify-between gap-bakin-3">
          <h2 id="project-files-heading">Attached</h2>
          <Button variant="outline" size="sm" onClick={() => openPicker({ type: 'attach' })}>
            <Paperclip aria-hidden="true" />
            Attach a file
          </Button>
        </div>

        {project.resolvedAssets.length === 0 ? (
          <SystemState kind="initial-empty" scope="inline" headingLevel={3} title="No files attached" description="Attach specs, designs or docs the project should keep close." />
        ) : (
          <div className="flex flex-col gap-bakin-2">
            {project.resolvedAssets.some(asset => asset.missing) && (
              <Alert tone="attention">
                <AlertDescription>
                  Some attached files could not be loaded. Detach broken references to clean up this project.
                </AlertDescription>
              </Alert>
            )}
            <ListRows variant="separated" size="sm" aria-label="Attached files">
              {project.resolvedAssets.map(asset => (
                <ListRow
                  key={asset.assetId}
                  className="flex items-start gap-bakin-2"
                  interactive={asset.missing ? undefined : { label: `Open ${assetName(asset)}`, onActivate: () => setPreview(asset) }}
                >
                  <AssetThumb asset={asset} />
                  <div className="min-w-0 flex-1">
                    <Text as="p" size="meta" className="truncate leading-tight">{assetName(asset)}</Text>
                    {asset.description && <Text as="p" size="meta" tone="muted" className="truncate">{asset.description}</Text>}
                    {asset.tags && asset.tags.length > 0 && (
                      <div className="mt-bakin-1 flex flex-wrap gap-bakin-1">
                        {asset.tags.slice(0, 3).map(tag => <Badge key={tag} size="xs" tone="neutral" variant="soft">{tag}</Badge>)}
                      </div>
                    )}
                    {asset.missing && <StatusBadge tone="attention" variant="soft" size="xs" className="mt-bakin-1">can't find asset</StatusBadge>}
                  </div>
                  <ListRowActions reveal="always">
                    <Button variant="ghost" size="xs" onClick={() => openPicker({ type: 'relink', target: asset })} aria-label={`Relink ${assetName(asset)}`}>
                      <Link2 aria-hidden="true" />
                      Relink
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => { setDetachError(null); setDetachTarget(asset) }} aria-label={`Detach ${assetName(asset)}`}>
                      <X aria-hidden="true" />
                    </Button>
                  </ListRowActions>
                </ListRow>
              ))}
            </ListRows>
          </div>
        )}

        <ConfirmDialog
          open={Boolean(detachTarget)}
          title="Detach file?"
          description={detachTarget ? <>This removes <Text weight="medium">{assetName(detachTarget)}</Text> from this project. It will not delete the file.</> : undefined}
          confirmLabel="Detach"
          busyLabel="Detaching..."
          confirmTone="danger"
          busy={detaching}
          error={detachError}
          onConfirm={() => { if (detachTarget) void detach(detachTarget) }}
          onCancel={() => { if (!detaching) setDetachTarget(null) }}
        >
          {detachTarget?.missing && (
            <Alert tone="attention">
              <AlertDescription>Bakin can't find this file. Detaching it cleans up the broken project reference.</AlertDescription>
            </Alert>
          )}
        </ConfirmDialog>

        <AssetPicker
          open={pickerOpen}
          onOpenChange={(open) => { if (!open && picking) return; setPickerOpen(open) }}
          collection={collection}
          query={search}
          onQueryChange={setSearch}
          onPick={(assetId) => { void pick(assetId) }}
          onRetry={() => { void loadCollection(pickerMode) }}
          busy={picking}
          notice={pickerError}
          view="list"
          title={pickerMode.type === 'relink' ? 'Relink file' : 'Attach a file'}
          description={pickerMode.type === 'relink'
            ? `Choose a replacement for ${assetName(pickerMode.target)}.`
            : 'Choose a file from the asset library to attach to this project.'}
          emptyTitle="No assets available"
          emptyDescription="Add an asset to the library, then return here to choose it."
        />

        {preview && <AssetPreviewModal asset={preview} onClose={() => setPreview(null)} />}
      </section>
    </div>
  )
}
