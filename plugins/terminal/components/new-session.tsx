import { useEffect, useState, type FormEvent } from 'react'
import { pluginFetch } from '@makinbakin/sdk/utils'
import { AgentSelect } from '@makinbakin/sdk/patterns'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Form, Field, FieldLabel, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, FormActions, SubmitButton, Alert, AlertDescription, Button } from '@makinbakin/sdk/ui'
import type { Session } from '../lib/contracts'
import type { SessionOptionsData } from '../lib/session-options'
import { api } from './api'
import { useTerminalAgents } from './use-terminal-agents'

const programs: Record<string, string> = { shell: 'Shell', claude: 'Claude Code', codex: 'Codex' }
const none = '__none__'
export function NewSession({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange(open: boolean): void; onCreated(session: Session): void }) {
  const [title, setTitle] = useState<string | null>(null)
  const [cwd, setCwd] = useState('')
  const [program, setProgram] = useState('shell')
  const [checkout, setCheckout] = useState('isolated')
  const [agentId, setAgentId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [options, setOptions] = useState<SessionOptionsData>()
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([])
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [cwdEdited, setCwdEdited] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setError(''); setOptions(undefined)
    setTitle(null); setProgram('shell'); setCheckout('isolated'); setTaskId(''); setProjectId(''); setCwdEdited(false)
    void Promise.all([
      api<SessionOptionsData>('/options'),
      pluginFetch('projects', '/').then(async (response) => {
        if (response.status === 404) return { projects: [] }
        if (!response.ok) throw new Error('Could not load projects')
        return await response.json() as { projects: Array<{ id: string; title: string }> }
      }),
    ]).then(([data, projectData]) => {
      if (cancelled) return
      setOptions(data); setProjects(projectData.projects)
      setAgentId(data.defaults.agentId); setCwd(data.defaults.cwd)
    }).catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : 'Could not load terminal choices')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, attempt])
  const agentChoices = useTerminalAgents(options?.agents)
  const agent = agentChoices.find((item) => item.id === agentId)
  const task = options?.tasks.find((item) => item.id === taskId)
  const suggestedTitle = task?.title ?? `${programs[program]}${agent ? ` - ${agent.name}` : ''}`
  function assignAgent(id: string) {
    setAgentId(id)
    if (!cwdEdited) setCwd(options?.agents.find((item) => item.id === id)?.workspace ?? options?.defaults.cwd ?? '')
  }
  function chooseTask(id: string) {
    setTaskId(id)
    const selected = options?.tasks.find((item) => item.id === id)
    if (selected?.projectId && projects.some((item) => item.id === selected.projectId)) setProjectId(selected.projectId)
    if (selected?.agentId && options?.agents.some((item) => item.id === selected.agentId && item.enabled)) assignAgent(selected.agentId)
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const session = await api<Session>('/sessions', { title: (title ?? suggestedTitle).slice(0, 100), cwd, program, checkout, agentId: agentId || undefined, taskId: taskId || undefined, projectId: projectId || undefined })
      onCreated(session); onOpenChange(false)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create session') }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent><DialogHeader><DialogTitle>New terminal</DialogTitle><DialogDescription>Commands run with your host account permissions.</DialogDescription></DialogHeader>
      <Form onSubmit={submit} busy={busy}>
        {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
        {!options && !loading && <Button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry loading choices</Button>}
        <Field name="title"><FieldLabel>Title</FieldLabel><Input value={title ?? suggestedTitle.slice(0, 100)} disabled={loading || busy} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} required maxLength={100} /></Field>
        <Field name="program"><FieldLabel>Program</FieldLabel><Select items={{ shell: 'Shell', claude: 'Claude Code', codex: 'Codex' }} value={program} onValueChange={(value: string | null) => { if (value) setProgram(value) }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="shell">Shell</SelectItem><SelectItem value="claude">Claude Code</SelectItem><SelectItem value="codex">Codex</SelectItem></SelectContent></Select></Field>
        <Field name="cwd"><FieldLabel>Working directory</FieldLabel><Input value={cwd} disabled={loading || busy} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setCwd(e.target.value); setCwdEdited(true) }} required placeholder={loading ? 'Loading...' : '/absolute/path'} /></Field>
        {program !== 'shell' && <Field name="checkout"><FieldLabel>Checkout</FieldLabel><Select items={{ isolated: 'New isolated worktree', existing: 'Existing checkout' }} value={checkout} onValueChange={(value: string | null) => { if (value) setCheckout(value) }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="isolated">New isolated worktree</SelectItem><SelectItem value="existing">Existing checkout</SelectItem></SelectContent></Select></Field>}
        <Field name="agent"><FieldLabel>Assigned agent</FieldLabel><AgentSelect id="terminal-new-agent" name="agent" className="w-full" ariaLabel="Assigned agent" value={agentId} onValueChange={assignAgent} agents={agentChoices} allowNone disabled={loading || busy} /></Field>
        <Field name="task"><FieldLabel>Task</FieldLabel><Select items={{ [none]: 'No task', ...Object.fromEntries((options?.tasks ?? []).map((item) => [item.id, item.title])) }} value={taskId || none} disabled={loading || busy} onValueChange={(value: string | null) => chooseTask(value === none ? '' : value ?? '')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={none}>No task</SelectItem>{options?.tasks.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></Field>
        <Field name="project"><FieldLabel>Project</FieldLabel><Select items={{ [none]: 'No project', ...Object.fromEntries(projects.map((item) => [item.id, item.title])) }} value={projectId || none} disabled={loading || busy} onValueChange={(value: string | null) => setProjectId(value === none ? '' : value ?? '')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={none}>No project</SelectItem>{projects.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></Field>
        <FormActions><SubmitButton busyLabel="Starting" disabled={loading || !options || !cwd.trim() || !(title ?? suggestedTitle).trim()}>Start terminal</SubmitButton></FormActions>
      </Form>
    </DialogContent>
  </Dialog>
}
