'use client'

import { useEffect, useState, type FormEvent } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Form,
  FormActions,
  Input,
  SubmitButton,
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
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <Form aria-label="New project" busy={creating} onSubmit={handleSubmit}>
          <Field name="title">
            <FieldLabel requirement="required">Project title</FieldLabel>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Project title..."
              autoFocus
              disabled={creating}
            />
          </Field>
          {error && (
            <Alert tone="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FormActions>
            <Button type="button" variant="outline" onClick={onCancel} disabled={creating}>
              Cancel
            </Button>
            <SubmitButton busyLabel="Creating..." disabled={!trimmedTitle}>
              Create Project
            </SubmitButton>
          </FormActions>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
