import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { PageHeader, WorkspacePage, WorkspacePageHeader, WorkspacePageCompactHeader, WorkspacePageBody, ConfirmDialog, AgentSelect } from '@makinbakin/sdk/patterns'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { Alert, AlertDescription, Badge, Button, SystemState, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Text, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Popover, PopoverTrigger, PopoverContent, PopoverTitle, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@makinbakin/sdk/ui'
import { PluginLink, useRouter } from '@makinbakin/sdk/navigation'
import { Plus, Hand, Play, Square, Check, Trash2, UserRoundCheck, CornerDownLeft, Info, Ellipsis, Terminal, RotateCw } from 'lucide-react'
import type { Session } from '../lib/contracts'
import type { SessionOptionsData } from '../lib/session-options'
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
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assignment, setAssignment] = useState('')
  const [agents, setAgents] = useState<SessionOptionsData['agents']>([])
  const [agentsError, setAgentsError] = useState('')
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
      setLoadError('')
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'Terminal unavailable') }
    finally { setLoading(false) }
  }, [update])
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [refresh])
  const loadAgents = useCallback(async () => {
    try { setAgents((await api<SessionOptionsData>('/options')).agents); setAgentsError('') }
    catch { setAgentsError('Agent choices could not be loaded') }
  }, [])
  useEffect(() => { if (sessionId) void loadAgents() }, [sessionId, loadAgents])
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
  const newTerminal = <Button size="sm" onClick={() => setCreating(true)} disabled={!serviceReady || Boolean(loadError) || busy}><Plus size={16} />New terminal</Button>
  return <TooltipProvider><WorkspacePage mode="immersive" className="terminal-page" data-terminal-ui-ready={!loading ? '' : undefined}>
    <WorkspacePageHeader>
        <PageHeader title="Terminal" meta={!loading && !loadError && serviceReady ? <Badge size="xs" variant="outline">{all.filter((item) => item.state === 'running').length} running</Badge> : undefined} actions={all.length > 0 ? newTerminal : undefined} />
    </WorkspacePageHeader>
    <WorkspacePageCompactHeader title="Terminal" action={all.length > 0 ? newTerminal : undefined} />
    <WorkspacePageBody>
      <Stack as="section" gap="none" className="min-h-0 flex-1 overflow-y-auto" aria-label="Selected terminal">
        {(loadError && all.length > 0 || error) && <Stack gap="item" className="shrink-0 p-bakin-4">
          {loadError && all.length > 0 && <SystemState kind="error" scope="inline" title="Terminals could not be refreshed" description={loadError} action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RotateCw size={16} />Retry</Button>} />}
          {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
        </Stack>}
        {all.length > 0 && <Inline gap="dense" className="shrink-0 px-bakin-4 py-bakin-2" aria-label="Terminal controls">
          <div className="min-w-0 flex-1">
          <Select items={Object.fromEntries(all.map((item) => [item.id, item.title]))} value={sessionId ?? null} onValueChange={(id: string | null) => { if (id) router.push(`/terminal/${encodeURIComponent(id)}`) }}>
            <SelectTrigger aria-label="Terminal session" className="w-full"><SelectValue placeholder="Select a terminal" /></SelectTrigger>
            <SelectContent>{all.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent>
          </Select>
          </div>
          {session && <Inline gap="dense">
            <Popover>
              <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Session details" title="Session details" />}><Info size={16} /></PopoverTrigger>
              <PopoverContent align="end">
                <Stack gap="item">
                  <PopoverTitle>Session details</PopoverTitle>
                  <Stack gap="dense">
                    <Text weight="semibold">{session.title}</Text>
                    <Text size="meta" tone="muted" mono>{session.cwd}</Text>
                    <Text size="meta" tone="muted">{session.program} / {session.state}</Text>
                    {session.worktreePath && <Badge size="xs" variant="outline">Worktree retained</Badge>}
                  </Stack>
                  <Inline gap="dense">
                    <AgentSelect ariaLabel="Assigned agent" value={assignment} onValueChange={setAssignment} agents={agents.map((agent) => ({ id: agent.id, name: agent.enabled ? agent.name : `${agent.name} (access disabled)`, disabled: !agent.enabled }))} allowNone disabled={busy || Boolean(agentsError)} />
                    <Tool label="Assign agent" disabled={busy || Boolean(agentsError) || assignment === (session.agentId ?? '')} onClick={() => void operate('assign', { agentId: assignment || undefined })}><UserRoundCheck size={16} /></Tool>
                  </Inline>
                  {agentsError && <SystemState kind="error" scope="inline" title={agentsError} description="Current assignment is unchanged." action={<Button size="sm" variant="outline" onClick={() => void loadAgents()}>Retry agents</Button>} />}
                  {session.taskId && <PluginLink to={`/tasks?taskId=${encodeURIComponent(session.taskId)}`}><CornerDownLeft size={14} />Task {session.taskId}</PluginLink>}
                  {session.projectId && <PluginLink to={`/projects/${encodeURIComponent(session.projectId)}`}><CornerDownLeft size={14} />Project {session.projectId}</PluginLink>}
                </Stack>
              </PopoverContent>
            </Popover>
            <Tool label="Take control" disabled={busy || writable || session.state === 'completed'} onClick={() => void operate('take')}><Hand size={16} /></Tool>
            <Tool label="Return control to agent" disabled={busy || !session.agentId || !writable} onClick={() => void operate('return')}><Play size={16} /></Tool>
            <Tool label="Interrupt process" disabled={busy || !writable} onClick={() => input('\x03')}><Square size={16} /></Tool>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Session actions" title="Session actions" />}><Ellipsis size={16} /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy || session.state === 'completed'} onClick={() => void operate('complete')}><Check size={16} />Complete session</DropdownMenuItem>
                <DropdownMenuItem variant="danger" disabled={busy || session.state === 'completed'} onClick={() => setConfirm('terminate')}><Trash2 size={16} />Terminate and complete</DropdownMenuItem>
                <DropdownMenuItem variant="danger" disabled={busy || session.state !== 'completed' || session.historyDeleted} onClick={() => setConfirm('delete-history')}><Trash2 size={16} />Delete completed output</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Inline>}
        </Inline>}
        {loading ? <SystemState kind="loading" scope="page" title="Loading terminals" description="Checking terminal service and sessions." />
          : loadError && all.length === 0 ? <SystemState kind="error" scope="page" title="Terminals could not be loaded" description={loadError} action={<Button variant="outline" onClick={() => void refresh()}><RotateCw size={16} />Retry</Button>} />
          : !serviceReady && !session ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="Terminal service is not set up" description="The persistent terminal service is unavailable on this Bakin instance." action={<Button disabled={busy} onClick={() => void setup()}><Play size={16} />Set up service</Button>} />
          : !session ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title={sessionId ? 'Terminal not found' : all.length ? 'No terminal selected' : 'No terminals yet'} description={all.length ? `${all.length} saved ${all.length === 1 ? 'session' : 'sessions'}.` : 'No terminal sessions have been created.'} action={all.length ? <Button variant="outline" onClick={() => router.push(`/terminal/${encodeURIComponent(all[0].id)}`)}>Open latest terminal</Button> : newTerminal} /> : <>
          {(!serviceReady || session.cleanupReason) && <Stack gap="item" className="shrink-0 p-bakin-4">
          {!serviceReady && <SystemState kind="error" scope="inline" title="Terminal service unavailable" description="Existing sessions are retained." action={<Button disabled={busy} onClick={() => void setup()}>Set up service</Button>} />}
          {session.cleanupReason && <Alert tone="attention"><AlertDescription>{session.cleanupReason}</AlertDescription></Alert>}
          </Stack>}
          <Separator />
          {session.historyDeleted ? <SystemState kind="initial-empty" scope="page" title="Output history deleted" description="Session metadata is retained." /> : <TerminalCanvas session={session} writable={writable} controlStatus={session.state === 'completed' ? 'Completed' : writable ? 'You have control' : session.owner.kind === 'agent' ? `${agents.find((agent) => agent.id === session.owner.id)?.name ?? session.owner.id} has control` : 'Read only'} onInput={input} onSession={update} onResize={(cols, rows) => void operate('resize', { cols, rows })} />}
        </>}
      </Stack>
    </WorkspacePageBody>
    <NewSession open={creating} onOpenChange={setCreating} onCreated={(created) => { update(created); router.push(`/terminal/${encodeURIComponent(created.id)}`) }} />
    <ConfirmDialog open={confirm !== null} onCancel={() => setConfirm(null)} title={confirm === 'terminate' ? 'Terminate this session?' : 'Delete output history?'} description={confirm === 'terminate' ? 'This stops the running process. Unfinished worktrees will be retained.' : 'The retained terminal output will be permanently deleted.'} confirmLabel={confirm === 'terminate' ? 'Terminate' : 'Delete output'} onConfirm={async () => { if (confirm && await operate(confirm)) setConfirm(null) }} />
  </WorkspacePage></TooltipProvider>
}
export function TerminalPage(props: { sessionId?: string }) { return <Suspense><Workspace {...props} /></Suspense> }
