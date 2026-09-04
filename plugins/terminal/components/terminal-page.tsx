import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { PageHeader, WorkspacePage, WorkspacePageHeader, WorkspacePageBody, ConfirmDialog } from '@makinbakin/sdk/patterns'
import { Alert, AlertDescription, Badge, Button, Input, SystemState, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@makinbakin/sdk/ui'
import { PluginLink, useRouter } from '@makinbakin/sdk/navigation'
import { Plus, Hand, Play, Square, Check, Trash2, UserRoundCheck, CornerDownLeft } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { api, clientId } from './api'
import { TerminalCanvas } from './terminal-canvas'
import { NewSession } from './new-session'
import './terminal.css'

function Tool({ label, children, onClick, disabled }: { label: string; children: React.ReactNode; onClick(): void; disabled?: boolean }) {
  return <Tooltip><TooltipTrigger render={<Button aria-label={label} size="icon-sm" variant="ghost" disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}

function Workspace({ sessionId }: { sessionId?: string }) {
  const router = useRouter()
  const [all, setAll] = useState<Session[]>([])
  const current = useRef<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [serviceReady, setServiceReady] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assignment, setAssignment] = useState('')
  const [confirm, setConfirm] = useState<'terminate' | 'delete-history' | null>(null)
  const queue = useRef(Promise.resolve())
  const epoch = useRef(0)
  const update = useCallback((session: Session) => {
    const previous = current.current.find((item) => item.id === session.id)
    if (previous && (previous.revision ?? 0) >= (session.revision ?? 0)) return
    current.current = [...current.current.filter((item) => item.id !== session.id), session].sort((a, b) => b.createdAt - a.createdAt)
    setAll(current.current)
  }, [])
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ sessions: Session[]; serviceReady: boolean }>('/sessions')
      for (const session of result.sessions) update(session)
      setServiceReady(result.serviceReady)
    } catch (error) { setError(error instanceof Error ? error.message : 'Terminal unavailable') }
    finally { setLoading(false) }
  }, [update])
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [refresh])
  const session = all.find((item) => item.id === sessionId)
  const writable = Boolean(session && session.owner.kind === 'human' && session.owner.id === clientId() && session.state === 'running')
  useEffect(() => { setAssignment(session?.agentId ?? '') }, [session?.id, session?.agentId])
  async function operate(operation: string, extra: Record<string, unknown> = {}) {
    if (!session) return
    setBusy(true); setError(''); epoch.current++
    try {
      const result = await api<Session>('/session', { id: session.id, operation, generation: session.generation, ...extra })
      if (result.id) update(result)
      await refresh()
      return true
    } catch (error) { setError(error instanceof Error ? error.message : 'Terminal operation failed'); return false }
    finally { setBusy(false) }
  }
  function input(data: string) {
    if (!session || !writable) return
    const id = session.id, generation = session.generation, batch = epoch.current
    queue.current = queue.current.then(async () => {
      if (batch !== epoch.current) return
      const latest = current.current.find((entry) => entry.id === id)!
      if (latest.generation !== generation) return
      const updated = await api<Session>('/session', { id, operation: 'write', generation, sequence: latest.inputSequence + 1, data })
      update(updated)
    }).catch((error) => { epoch.current++; setError(error.message); void refresh() })
  }
  async function setup() {
    setBusy(true); setError('')
    try { await api('/service', {}); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : 'Service setup failed') }
    finally { setBusy(false) }
  }
  return <TooltipProvider><WorkspacePage className="terminal-page" data-terminal-ui-ready={!loading ? '' : undefined}>
    <WorkspacePageHeader><PageHeader title="Terminal" meta={<Badge variant="outline">{all.filter((item) => item.state === 'running').length} running</Badge>} actions={<Button onClick={() => setCreating(true)} disabled={!serviceReady || busy}><Plus size={16} />New terminal</Button>} /></WorkspacePageHeader>
    {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
    <WorkspacePageBody className="terminal-workspace">
      <aside className="terminal-rail" aria-label="Terminal sessions">
        {all.map((item) => <PluginLink key={item.id} to={`/terminal/${encodeURIComponent(item.id)}`} className="terminal-session-link" aria-current={item.id === sessionId ? 'page' : undefined}>
          <strong>{item.title}</strong><span>{item.program} / {item.state}</span><small>{item.agentId ?? 'Unassigned'}{item.worktreePath ? ' / Worktree retained' : ''}</small>
        </PluginLink>)}
      </aside>
      <section className="terminal-main" aria-label="Selected terminal">
        {loading ? <SystemState kind="loading" title="Loading terminals" /> : !serviceReady && !session ? <SystemState kind="initial-empty" title="Terminal service is not set up" action={<Button disabled={busy} onClick={() => void setup()}>Set up service</Button>} /> : !session ? <SystemState kind="initial-empty" title={sessionId ? 'Terminal not found' : 'No terminal selected'} action={<Button onClick={() => setCreating(true)}><Plus size={16} />New terminal</Button>} /> : <>
          {!serviceReady && <Alert tone="attention"><AlertDescription>Terminal service unavailable</AlertDescription><Button disabled={busy} onClick={() => void setup()}>Set up service</Button></Alert>}
          <div className="terminal-toolbar">
            <div className="terminal-identity"><strong>{session.title}</strong><span title={session.cwd}>{session.cwd}</span></div>
            <Badge variant="outline">{writable ? 'You have control' : session.owner.kind === 'agent' ? `${session.owner.id} has control` : 'Read only'}</Badge>
            <Tool label="Take control" disabled={busy} onClick={() => void operate('take')}><Hand size={16} /></Tool>
            <Tool label="Return control to agent" disabled={busy || !session.agentId || !writable} onClick={() => void operate('return')}><Play size={16} /></Tool>
            <Tool label="Interrupt process" disabled={busy || !writable} onClick={() => input('\x03')}><Square size={16} /></Tool>
            <Tool label="Complete session" disabled={busy || session.state === 'completed'} onClick={() => void operate('complete')}><Check size={16} /></Tool>
            <Tool label="Terminate and complete" disabled={busy || session.state === 'completed'} onClick={() => setConfirm('terminate')}><Trash2 size={16} /></Tool>
          </div>
          <div className="terminal-assignment">
            <Input aria-label="Assigned agent ID" value={assignment} placeholder="Unassigned" onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAssignment(event.target.value)} />
            <Tool label="Assign agent" disabled={busy} onClick={() => void operate('assign', { agentId: assignment || undefined })}><UserRoundCheck size={16} /></Tool>
            <Tool label="Delete completed output" disabled={busy || session.state !== 'completed'} onClick={() => setConfirm('delete-history')}><Trash2 size={16} /></Tool>
            {session.taskId && <PluginLink to={`/tasks?taskId=${encodeURIComponent(session.taskId)}`}><CornerDownLeft size={14} />Task {session.taskId}</PluginLink>}
            {session.projectId && <PluginLink to={`/projects/${encodeURIComponent(session.projectId)}`}><CornerDownLeft size={14} />Project {session.projectId}</PluginLink>}
          </div>
          {session.cleanupReason && <Alert tone="attention"><AlertDescription>{session.cleanupReason}</AlertDescription></Alert>}
          {session.historyDeleted ? <SystemState kind="initial-empty" title="Output history deleted" /> : <TerminalCanvas session={session} writable={writable} onInput={input} onSession={update} onResize={(cols, rows) => void operate('resize', { cols, rows })} />}
        </>}
      </section>
    </WorkspacePageBody>
    <NewSession open={creating} onOpenChange={setCreating} onCreated={(created) => { update(created); router.push(`/terminal/${encodeURIComponent(created.id)}`) }} />
    <ConfirmDialog open={confirm !== null} onCancel={() => setConfirm(null)} title={confirm === 'terminate' ? 'Terminate this session?' : 'Delete output history?'} description={confirm === 'terminate' ? 'This stops the running process. Unfinished worktrees will be retained.' : 'The retained terminal output will be permanently deleted.'} confirmLabel={confirm === 'terminate' ? 'Terminate' : 'Delete output'} onConfirm={async () => { if (confirm && await operate(confirm)) setConfirm(null) }} />
  </WorkspacePage></TooltipProvider>
}
export function TerminalPage(props: { sessionId?: string }) { return <Suspense><Workspace {...props} /></Suspense> }
