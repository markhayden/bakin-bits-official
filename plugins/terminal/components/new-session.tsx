import { useState, type FormEvent } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Form, Field, FieldLabel, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, FormActions, SubmitButton, Alert, AlertDescription } from '@makinbakin/sdk/ui'
import type { Session } from '../lib/contracts'
import { api } from './api'

export function NewSession({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange(open: boolean): void; onCreated(session: Session): void }) {
  const [title, setTitle] = useState('Shell')
  const [cwd, setCwd] = useState('')
  const [program, setProgram] = useState('shell')
  const [checkout, setCheckout] = useState('isolated')
  const [agentId, setAgentId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const session = await api<Session>('/sessions', { title, cwd, program, checkout, agentId: agentId || undefined, taskId: taskId || undefined, projectId: projectId || undefined })
      onCreated(session); onOpenChange(false)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create session') }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent><DialogHeader><DialogTitle>New terminal</DialogTitle><DialogDescription>Commands run with your host account permissions.</DialogDescription></DialogHeader>
      <Form onSubmit={submit} busy={busy}>
        {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
        <Field name="title"><FieldLabel>Title</FieldLabel><Input value={title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} required maxLength={100} /></Field>
        <Field name="program"><FieldLabel>Program</FieldLabel><Select items={{ shell: 'Shell', claude: 'Claude Code', codex: 'Codex' }} value={program} onValueChange={(value: string | null) => { if (value) setProgram(value) }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="shell">Shell</SelectItem><SelectItem value="claude">Claude Code</SelectItem><SelectItem value="codex">Codex</SelectItem></SelectContent></Select></Field>
        <Field name="cwd"><FieldLabel>Working directory</FieldLabel><Input value={cwd} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCwd(e.target.value)} required placeholder="/absolute/path" /></Field>
        {program !== 'shell' && <Field name="checkout"><FieldLabel>Checkout</FieldLabel><Select items={{ isolated: 'New isolated worktree', existing: 'Existing checkout' }} value={checkout} onValueChange={(value: string | null) => { if (value) setCheckout(value) }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="isolated">New isolated worktree</SelectItem><SelectItem value="existing">Existing checkout</SelectItem></SelectContent></Select></Field>}
        <Field name="agent"><FieldLabel>Assigned agent ID</FieldLabel><Input value={agentId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgentId(e.target.value)} /></Field>
        <Field name="task"><FieldLabel>Task ID</FieldLabel><Input value={taskId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTaskId(e.target.value)} /></Field>
        <Field name="project"><FieldLabel>Project ID</FieldLabel><Input value={projectId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectId(e.target.value)} /></Field>
        <FormActions><SubmitButton busyLabel="Starting" disabled={!cwd.trim() || !title.trim()}>Start terminal</SubmitButton></FormActions>
      </Form>
    </DialogContent>
  </Dialog>
}
