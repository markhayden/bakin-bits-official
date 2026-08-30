'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AgentSelect, AssetPicker, ChannelIcon } from "@makinbakin/sdk/patterns"
import type { AssetPickerCollection } from "@makinbakin/sdk/patterns"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  Fieldset,
  FieldsetLegend,
  Form,
  FormActions,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SubmitButton,
  Textarea,
} from "@makinbakin/sdk/ui"
import { Paperclip, Plus, X } from 'lucide-react'
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
  // The plugin owns the library data (assets-plugin REST fetch); the kit
  // AssetPicker owns the presentation, so loading/error land as honest states.
  const [assetCollection, setAssetCollection] = useState<AssetPickerCollection>({ status: 'loading' })
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
    setAssetCollection({ status: 'loading' })
    setAssetPickerOpen(true)
    try {
      const response = await fetch('/api/plugins/assets/versioned')
      if (!response.ok) throw new Error(`Asset library returned ${response.status}`)
      const data = await response.json() as { assets?: Array<{ assetId: string; type?: string; description?: string }> }
      const options = Array.isArray(data.assets)
        ? data.assets.map((a) => ({ assetId: a.assetId, type: a.type, description: a.description }))
        : []
      setAssets(options)
      setAssetCollection({
        status: 'ready',
        assets: options.map((asset) => ({
          id: asset.assetId,
          label: asset.assetId,
          description: asset.description,
          type: asset.type,
        })),
      })
    } catch (err) {
      setAssets([])
      setAssetCollection({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
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
        <Plus data-icon="inline-start" aria-hidden="true" />
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

          <Form busy={saving} onSubmit={handleCreate} aria-label="Quick post form">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="quick-post-title" requirement="required">Title</FieldLabel>
                <Input id="quick-post-title" value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>

              <Field>
                <FieldLabel htmlFor="quick-post-brief" requirement="required">Brief</FieldLabel>
                <FieldControl
                  render={(
                    <Textarea
                      id="quick-post-brief"
                      value={brief}
                      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setBrief(event.target.value)}
                      className="min-h-24"
                    />
                  )}
                />
              </Field>

              <div className="grid gap-bakin-3 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="quick-post-agent">Agent</FieldLabel>
                  <AgentSelect
                    id="quick-post-agent"
                    value={agent}
                    onValueChange={(value) => setAgent(value ?? '')}
                    agents={agentOptions}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quick-post-publish-at">Publish</FieldLabel>
                  <Input id="quick-post-publish-at" type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quick-post-content-type">Content Type</FieldLabel>
                  <Select
                    items={Object.fromEntries(contentTypes.map((type) => [type.id, type.label]))}
                    value={selectedContentType?.id ?? ''}
                    onValueChange={(value) => setContentType(value ?? '')}
                  >
                    <SelectTrigger id="quick-post-content-type" className="w-full">
                      <SelectValue placeholder="Content type" />
                    </SelectTrigger>
                    <SelectContent>
                      {contentTypes.map((type) => (
                        <SelectItem key={type.id} value={type.id}>{type.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="quick-post-tone">Tone</FieldLabel>
                  <Select
                    items={Object.fromEntries(Object.entries(TONE_LABELS))}
                    value={tone}
                    onValueChange={(value) => setTone((value ?? 'conversational') as ContentTone)}
                  >
                    <SelectTrigger id="quick-post-tone" className="w-full">
                      <SelectValue placeholder="Tone" />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.entries(TONE_LABELS) as Array<[ContentTone, string]>).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Fieldset>
                <FieldsetLegend>Channel</FieldsetLegend>
                {/* Kit gap: a single-select chip group — aria-pressed toggles until the kit ships one. */}
                <div className="flex flex-wrap gap-bakin-2">
                  {(channels.length > 0 ? channels : [{ id: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL }]).map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      size="xs"
                      variant={channel === item.id ? 'accent' : 'outline'}
                      aria-pressed={channel === item.id}
                      onClick={() => setChannel(item.id)}
                    >
                      <ChannelIcon channelId={item.id} className="size-3.5" />
                      {item.label}
                    </Button>
                  ))}
                </div>
              </Fieldset>

              <Fieldset>
                <div className="flex items-center justify-between gap-bakin-2">
                  <FieldsetLegend>Existing Asset</FieldsetLegend>
                  <Button type="button" size="sm" variant="outline" onClick={loadAssets}>
                    <Paperclip data-icon="inline-start" aria-hidden="true" />
                    Attach
                  </Button>
                </div>
                {selectedAsset && (
                  <div className="flex flex-wrap gap-bakin-1">
                    <Badge variant="outline" className="max-w-full gap-bakin-1">
                      <span className="truncate">{selectedAsset.description || selectedAsset.assetId}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setSelectedAsset(null)}
                        aria-label="Remove selected asset"
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </Badge>
                  </div>
                )}
              </Fieldset>
            </FieldGroup>

            <FormActions>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <SubmitButton busyLabel="Creating..." disabled={saving || !title.trim() || !brief.trim()}>
                Create
              </SubmitButton>
            </FormActions>
          </Form>
        </DialogContent>
      </Dialog>

      <AssetPicker
        open={assetPickerOpen}
        onOpenChange={setAssetPickerOpen}
        collection={assetCollection}
        query={assetSearch}
        onQueryChange={setAssetSearch}
        onPick={(assetId) => {
          const asset = assets.find((candidate) => candidate.assetId === assetId)
          if (asset) setSelectedAsset(asset)
          setAssetPickerOpen(false)
        }}
        onRetry={() => { void loadAssets() }}
        view="list"
        title="Attach asset"
        description="Choose an existing asset from the library for this post."
      />
    </>
  )
}
