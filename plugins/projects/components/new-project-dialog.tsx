'use client'

import { useEffect, useState, type FormEvent } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from '@makinbakin/sdk/ui'

interface NewProjectDialogProps {
  open: boolean
  creating?: boolean
  error?: string | null
  onConfirm: (title: string) => void | Promise<void>
  onCancel: () => void
}

export function NewProjectDialog({
  open,
  creating = false,
  error = null,
  onConfirm,
  onCancel,
}: NewProjectDialogProps) {
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (open) setTitle('')
  }, [open])

  const trimmedTitle = title.trim()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmedTitle || creating) return
    void onConfirm(trimmedTitle)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !creating) onCancel() }}>
      <DialogContent className="bg-card border-border max-w-sm">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Project title..."
            autoFocus
            disabled={creating}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 mt-1">
            <Button type="button" variant="outline" onClick={onCancel} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmedTitle || creating}>
              {creating ? 'Creating...' : 'Create Project'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
