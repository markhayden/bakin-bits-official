import { useCallback, useRef, useState } from 'react'
import { toast } from '@makinbakin/sdk/hooks'
import type { ComposerAttachments } from '@makinbakin/sdk/conversation'
import { projectRequest } from '../lib/project-api'

/** The file kinds the asset library stores (the composer has no "any file" wildcard). */
const ACCEPTED = ['image/*', 'video/*', 'audio/*', 'text/*', 'application/pdf', '.md', '.csv', '.json', '.docx', '.xlsx', '.pptx'] as const

type UploadItem = ComposerAttachments['items'][number]

/**
 * The project composer's paperclip (D17): a picked file uploads to the asset
 * library and attaches to the PROJECT — it lands in Files, not in the
 * message. A failure stays visible on its chip until removed.
 */
export function useProjectUploads(projectId: string, onAttached: () => Promise<unknown>): ComposerAttachments {
  const [items, setItems] = useState<UploadItem[]>([])
  // Removing a chip mid-upload cancels it: the request aborts and the
  // attach step never runs.
  const inFlight = useRef(new Map<string, AbortController>())
  const update = (id: string, next: Partial<UploadItem> | null) =>
    setItems(current => next === null ? current.filter(item => item.id !== id) : current.map(item => item.id === id ? { ...item, ...next } : item))

  const upload = useCallback(async (id: string, file: File) => {
    const controller = new AbortController()
    inFlight.current.set(id, controller)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/plugins/assets/upload', { method: 'POST', body: form, signal: controller.signal })
      const result = await res.json().catch(() => ({})) as { ok?: boolean; assetId?: string; error?: string }
      if (!res.ok || !result.ok || !result.assetId) throw new Error(result.error ?? `Upload failed (${res.status}).`)
      if (controller.signal.aborted) return
      await projectRequest(`${encodeURIComponent(projectId)}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: result.assetId, label: file.name }),
      })
      update(id, null)
      toast(`Attached ${file.name} to the project's files`, 'success')
      await onAttached()
    } catch (error) {
      if (controller.signal.aborted) return
      update(id, { status: 'error', errorMessage: error instanceof Error ? error.message : 'The file could not be attached.' })
    } finally {
      inFlight.current.delete(id)
    }
  }, [projectId, onAttached])

  return {
    enabled: true,
    acceptedTypes: ACCEPTED,
    multiple: true,
    items,
    onAdd: (files: File[]) => {
      for (const file of files) {
        const id = crypto.randomUUID()
        setItems(current => [...current, { id, name: file.name, status: 'uploading' }])
        void upload(id, file)
      }
    },
    onRemove: (id: string) => {
      inFlight.current.get(id)?.abort()
      update(id, null)
    },
  }
}
