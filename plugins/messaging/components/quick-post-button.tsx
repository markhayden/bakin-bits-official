'use client'

import { useEffect, useMemo, useState } from 'react'
import { AgentSelect } from "@makinbakin/sdk/components"
import { ChannelIcon } from "@makinbakin/sdk/components"
import { Button } from "@makinbakin/sdk/ui"
import { Input } from "@makinbakin/sdk/ui"
import { Textarea } from "@makinbakin/sdk/ui"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@makinbakin/sdk/ui"
import { Paperclip, Plus, Search, X } from 'lucide-react'
import type { ContentTone, DeliverableDraft } from '../types'
import { DEFAULT_CHANNEL } from '../types'
import { TONE_LABELS } from '../constants'
import { useContentTypes } from '../hooks/use-content-types'
import { useAgentIds } from "@makinbakin/sdk/hooks"
import { useNotificationChannels } from "@makinbakin/sdk/hooks"

interface AssetOption {
  filename: string
  type?: string
  description?: string
}

interface QuickPostButtonProps {
  onCreated?: () => void
}

function datetimeLocalValue(date = new Date(Date.now() + 60 * 60 * 1000)): string {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function assetDraftField(asset: AssetOption, requirement: string | undefined): keyof DeliverableDraft {
  if ((requirement ?? '').includes('video') || asset.type?.startsWith('video')) return 'videoFilename'
  return 'imageFilename'
}

export function QuickPostButton({ onCreated }: QuickPostButtonProps) {
  const contentTypes = useContentTypes()
  const agentIds = useAgentIds()
  const channels = useNotificationChannels()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [agent, setAgent] = useState('')
  const [channel, setChannel] = useState(DEFAULT_CHANNEL)
  const [contentType, setContentType] = useState('')
  const [tone, setTone] = useState<ContentTone>('conversational')
  const [publishAt, setPublishAt] = useState(datetimeLocalValue())
  const [saving, setSaving] = useState(false)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [assetSearch, setAssetSearch] = useState('')
  const [assets, setAssets] = useState<AssetOption[]>([])
  const [selectedAsset, setSelectedAsset] = useState<AssetOption | null>(null)

  const selectedContentType = useMemo(
    () => contentTypes.find((type) => type.id === contentType) ?? contentTypes[0],
    [contentType, contentTypes],
  )

  useEffect(() => {
    if (!open) return
    setAgent((current) => current || agentIds[0] || 'main')
    setContentType((current) => current || contentTypes[0]?.id || 'announcement')
    setChannel((current) => current || channels[0]?.id || DEFAULT_CHANNEL)
  }, [agentIds, channels, contentTypes, open])

  const reset = () => {
    setTitle('')
    setBrief('')
    setTone('conversational')
    setPublishAt(datetimeLocalValue())
    setSelectedAsset(null)
    setAssetSearch('')
    setAssetPickerOpen(false)
  }

  const loadAssets = async () => {
    try {
      const response = await fetch('/api/plugins/assets/?grouped=false')
      if (!response.ok) return
      const data = await response.json() as { assets?: AssetOption[] }
      setAssets(Array.isArray(data.assets) ? data.assets : [])
      setAssetPickerOpen(true)
    } catch {
      setAssets([])
      setAssetPickerOpen(true)
    }
  }

  const filteredAssets = assets.filter((asset) => {
    if (!assetSearch.trim()) return true
    const query = assetSearch.toLowerCase()
    return asset.filename.toLowerCase().includes(query) || (asset.description ?? '').toLowerCase().includes(query)
  })

  const handleCreate = async () => {
    if (!title.trim() || !brief.trim() || !agent || !channel || !selectedContentType) return
    setSaving(true)
    try {
      const draft: DeliverableDraft = {}
      if (selectedAsset) {
        draft[assetDraftField(selectedAsset, selectedContentType.assetRequirement)] = selectedAsset.filename
      }
      await fetch('/api/plugins/messaging/deliverables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: null,
          channel,
          contentType: selectedContentType.id,
          tone,
          agent,
          title: title.trim(),
          brief: brief.trim(),
          publishAt: new Date(publishAt).toISOString(),
          draft: Object.keys(draft).length > 0 ? draft : undefined,
        }),
      })
      await onCreated?.()
      setOpen(false)
      reset()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" data-icon="inline-start" />
        Quick Post
      </Button>

      <Dialog open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) reset()
      }}>
        <DialogContent className="max-w-lg border-border bg-card">
          <DialogHeader>
            <DialogTitle>Quick Post</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Title</label>
              <Input aria-label="Quick post title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>

            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Brief</label>
              <Textarea
                aria-label="Quick post brief"
                value={brief}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setBrief(event.target.value)}
                className="min-h-[96px]"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Agent</label>
                <AgentSelect value={agent} onValueChange={(value) => setAgent(value ?? '')} agentIds={agentIds} />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Publish</label>
                <Input aria-label="Quick post publish time" type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Content Type</label>
                <select
                  aria-label="Quick post content type"
                  value={selectedContentType?.id ?? ''}
                  onChange={(event) => setContentType(event.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm"
                >
                  {contentTypes.map((type) => (
                    <option key={type.id} value={type.id}>{type.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">Tone</label>
                <select
                  aria-label="Quick post tone"
                  value={tone}
                  onChange={(event) => setTone(event.target.value as ContentTone)}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm"
                >
                  {(Object.entries(TONE_LABELS) as Array<[ContentTone, string]>).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Channel</label>
              <div className="flex flex-wrap gap-1.5">
                {(channels.length > 0 ? channels : [{ id: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL }]).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setChannel(item.id)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                      channel === item.id
                        ? 'border-accent bg-accent text-accent-foreground'
                        : 'border-border text-muted-foreground'
                    }`}
                  >
                    <ChannelIcon channelId={item.id} className="size-3.5" />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm text-muted-foreground">Existing Asset</label>
                <Button size="sm" variant="outline" onClick={loadAssets}>
                  <Paperclip className="size-3.5" data-icon="inline-start" />
                  Attach
                </Button>
              </div>
              {selectedAsset && (
                <div className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm">
                  <span className="truncate">{selectedAsset.filename}</span>
                  <button type="button" onClick={() => setSelectedAsset(null)} aria-label="Remove selected asset">
                    <X className="size-4" />
                  </button>
                </div>
              )}
              {assetPickerOpen && (
                <div className="mt-2 rounded-md border border-border bg-surface p-2">
                  <div className="relative mb-2">
                    <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={assetSearch}
                      onChange={(event) => setAssetSearch(event.target.value)}
                      placeholder="Search assets..."
                      className="h-8 pl-8"
                    />
                  </div>
                  <div className="max-h-44 overflow-auto">
                    {filteredAssets.length === 0 ? (
                      <p className="p-2 text-sm text-muted-foreground">No assets available</p>
                    ) : (
                      filteredAssets.map((asset) => (
                        <button
                          key={asset.filename}
                          type="button"
                          onClick={() => {
                            setSelectedAsset(asset)
                            setAssetPickerOpen(false)
                          }}
                          className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                        >
                          <span className="block truncate">{asset.filename}</span>
                          {asset.description && (
                            <span className="block truncate text-xs text-muted-foreground">{asset.description}</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={saving || !title.trim() || !brief.trim()}>
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
