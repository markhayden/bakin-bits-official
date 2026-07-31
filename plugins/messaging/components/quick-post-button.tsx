'use client'

import { useEffect, useMemo, useState } from 'react'
import { AgentSelect } from "@makinbakin/sdk/patterns"
// ChannelIcon has no focused home yet (public-API checkpoint gap — it dies
// with the frozen barrel at P-final unless a focused home ships first).
import { ChannelIcon } from "@makinbakin/sdk/components"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@makinbakin/sdk/ui"
import { Paperclip, Plus, Search, X } from 'lucide-react'
import type { ContentTone, DeliverableDraft } from '../types'
import { DEFAULT_CHANNEL } from '../types'
import { TONE_LABELS } from '../constants'
import { useContentTypes } from '../hooks/use-content-types'
import { useAgentIds, useAgentList } from "@makinbakin/sdk/hooks"
import { useNotificationChannels } from "@makinbakin/sdk/hooks"

interface AssetOption {
  assetId: string
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
  if ((requirement ?? '').includes('video') || asset.type?.startsWith('video')) return 'videoAssetId'
  return 'imageAssetId'
}

export function QuickPostButton({ onCreated }: QuickPostButtonProps) {
  const contentTypes = useContentTypes()
  const agentIds = useAgentIds()
  const agentList = useAgentList()
  // The focused AgentSelect is presentation-only — the consumer supplies the
  // selectable agents with resolved names and portraits.
  const agentOptions = useMemo(() => {
    const byId = new Map(agentList.map((candidate) => [candidate.id, candidate]))
    return agentIds.map((id) => ({
      id,
      name: byId.get(id)?.name ?? id,
      imageSrc: byId.get(id)?.headshot ?? null,
    }))
  }, [agentIds, agentList])
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
      const response = await fetch('/api/plugins/assets/versioned')
      if (!response.ok) return
      const data = await response.json() as { assets?: Array<{ assetId: string; type?: string; description?: string }> }
      setAssets(Array.isArray(data.assets) ? data.assets.map((a) => ({ assetId: a.assetId, type: a.type, description: a.description })) : [])
      setAssetPickerOpen(true)
    } catch {
      setAssets([])
      setAssetPickerOpen(true)
    }
  }

  const filteredAssets = assets.filter((asset) => {
    if (!assetSearch.trim()) return true
    const query = assetSearch.toLowerCase()
    return asset.assetId.toLowerCase().includes(query) || (asset.description ?? '').toLowerCase().includes(query)
  })

  const handleCreate = async () => {
    if (!title.trim() || !brief.trim() || !agent || !channel || !selectedContentType) return
    setSaving(true)
    try {
      const draft: DeliverableDraft = {}
      if (selectedAsset) {
        draft[assetDraftField(selectedAsset, selectedContentType.assetRequirement)] = selectedAsset.assetId
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
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-3.5" data-icon="inline-start" />
        Quick Post
      </Button>

      <Dialog open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) reset()
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Quick Post</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-bakin-text-muted">Title</label>
              <Input aria-label="Quick post title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>

            <div>
              <label className="mb-1 block text-sm text-bakin-text-muted">Brief</label>
              <Textarea
                aria-label="Quick post brief"
                value={brief}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setBrief(event.target.value)}
                className="min-h-24"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm text-bakin-text-muted">Agent</label>
                <AgentSelect
                  value={agent}
                  onValueChange={(value) => setAgent(value ?? '')}
                  agents={agentOptions}
                  ariaLabel="Quick post agent"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-bakin-text-muted">Publish</label>
                <Input aria-label="Quick post publish time" type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm text-bakin-text-muted">Content Type</label>
                <Select
                  items={Object.fromEntries(contentTypes.map((type) => [type.id, type.label]))}
                  value={selectedContentType?.id ?? ''}
                  onValueChange={(value) => setContentType(value ?? '')}
                >
                  <SelectTrigger aria-label="Quick post content type" className="w-full">
                    <SelectValue placeholder="Content type" />
                  </SelectTrigger>
                  <SelectContent>
                    {contentTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-sm text-bakin-text-muted">Tone</label>
                <Select
                  items={Object.fromEntries(Object.entries(TONE_LABELS))}
                  value={tone}
                  onValueChange={(value) => setTone((value ?? 'conversational') as ContentTone)}
                >
                  <SelectTrigger aria-label="Quick post tone" className="w-full">
                    <SelectValue placeholder="Tone" />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(TONE_LABELS) as Array<[ContentTone, string]>).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-bakin-text-muted">Channel</label>
              <div className="flex flex-wrap gap-1.5">
                {(channels.length > 0 ? channels : [{ id: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL }]).map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    size="xs"
                    variant="outline"
                    aria-pressed={channel === item.id}
                    onClick={() => setChannel(item.id)}
                    className={channel === item.id
                      ? 'border-bakin-signal-accent bg-bakin-signal-accent text-bakin-text-primary hover:bg-bakin-signal-accent'
                      : 'border-bakin-border-subtle/30 text-bakin-text-muted'}
                  >
                    <ChannelIcon channelId={item.id} className="size-3.5" />
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm text-bakin-text-muted">Existing Asset</label>
                <Button size="sm" variant="outline" onClick={loadAssets}>
                  <Paperclip className="size-3.5" data-icon="inline-start" />
                  Attach
                </Button>
              </div>
              {selectedAsset && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-bakin-border-subtle/30 bg-bakin-canvas-default px-3 py-2 text-sm">
                  <span className="truncate">{selectedAsset.description || selectedAsset.assetId}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setSelectedAsset(null)}
                    aria-label="Remove selected asset"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              )}
              {assetPickerOpen && (
                <div className="mt-2 rounded-md border border-bakin-border-subtle/30 bg-bakin-canvas-default p-2">
                  <div className="relative mb-2">
                    <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-bakin-text-muted" />
                    <Input
                      value={assetSearch}
                      onChange={(event) => setAssetSearch(event.target.value)}
                      placeholder="Search assets..."
                      className="h-8 pl-8"
                    />
                  </div>
                  <div className="max-h-44 overflow-auto">
                    {filteredAssets.length === 0 ? (
                      <p className="p-2 text-sm text-bakin-text-muted">No assets available</p>
                    ) : (
                      filteredAssets.map((asset) => (
                        <Button
                          key={asset.assetId}
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setSelectedAsset(asset)
                            setAssetPickerOpen(false)
                          }}
                          className="block h-auto w-full min-w-0 rounded-md px-2 py-1.5 text-left text-sm font-bakin-typography-weight-regular hover:bg-bakin-surface-default"
                        >
                          <span className="block truncate">{asset.assetId}</span>
                          {asset.description && (
                            <span className="block truncate text-xs text-bakin-text-muted">{asset.description}</span>
                          )}
                        </Button>
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
