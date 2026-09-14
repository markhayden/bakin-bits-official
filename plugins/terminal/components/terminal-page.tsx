import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Page, PageBody, PageHeader, WorkspacePage, WorkspacePageHeader, WorkspacePageCompactHeader, WorkspacePageBody, ConfirmDialog, AgentAvatar, AgentSelect, DataTable, SegmentedControl } from '@makinbakin/sdk/patterns'
import { Inline, Stack } from '@makinbakin/sdk/layout'
import { Alert, AlertDescription, Badge, Button, SystemState, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Text, Separator, Popover, PopoverTrigger, PopoverContent, PopoverTitle, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@makinbakin/sdk/ui'
import { PluginLink, useQueryState, useRouter } from '@makinbakin/sdk/navigation'
import { formatAge } from '@makinbakin/sdk/utils'
import { Plus, Hand, Play, Square, UserRoundCheck, CornerDownLeft, ArrowLeft, Info, Terminal, RotateCw } from 'lucide-react'
import type { Session } from '../lib/contracts'
import type { SessionOptionsData } from '../lib/session-options'
import { api } from './api'
import { TerminalCanvas } from './terminal-canvas'
import { NewSession } from './new-session'
import { TerminalTool as Tool } from './terminal-tool'
import { useTerminalAgents } from './use-terminal-agents'
import { SessionActions, type SessionConfirmation } from './session-actions'
import './terminal.css'

const VIEWS = ['active', 'review', 'completed', 'all'] as const
type SessionView = (typeof VIEWS)[number]
function matchesView(item: Session, target: SessionView): boolean {
  if (target === 'all') return true
  if (target === 'review') return Boolean(item.cleanupReason)
  return target === 'completed' ? item.state === 'completed' : item.state !== 'completed'
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
  const [captureTab, setCaptureTab] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [streamStatus, setStreamStatus] = useState('Connecting')
  useEffect(() => { setCaptureTab(false); setAttempt(0); setStreamStatus('Connecting') }, [sessionId])
  const [agents, setAgents] = useState<SessionOptionsData['agents']>([])
  const [agentsError, setAgentsError] = useState('')
  const agentChoices = useTerminalAgents(agents)
  const [confirm, setConfirm] = useState<SessionConfirmation | null>(null)
  const queue = useRef(Promise.resolve())
  const epoch = useRef(0)
  const listEpoch = useRef(0)
  const update = useCallback((session: Session) => {
    const previous = current.current.find((item) => item.id === session.id)
    if (previous && (previous.revision ?? 0) >= (session.revision ?? 0)) return
    if (!previous) listEpoch.current++
    current.current = [...current.current.filter((item) => item.id !== session.id), session].sort((a, b) => b.createdAt - a.createdAt)
    setAll(current.current)
  }, [])
  const remove = useCallback((ids: (id: string) => boolean) => {
    if (!current.current.some((item) => ids(item.id))) return
    current.current = current.current.filter((item) => !ids(item.id))
    setAll(current.current)
  }, [])
  const refresh = useCallback(async () => {
    try {
      const known = listEpoch.current
      const result = await api<{ sessions: Session[]; serviceReady: boolean }>('/sessions')
      for (const session of result.sessions) update(session)
      // Deleted sessions vanish from the server list. Drop them locally, but
      // never against a response older than a session added while in flight.
      if (listEpoch.current === known) {
        const listed = new Set(result.sessions.map((session) => session.id))
        remove((id) => !listed.has(id))
      }
      setServiceReady(result.serviceReady)
      setLoadError('')
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'Terminal unavailable') }
    finally { setLoading(false) }
  }, [update, remove])
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [refresh])
  const loadAgents = useCallback(async () => {
    try { setAgents((await api<SessionOptionsData>('/options')).agents); setAgentsError('') }
    catch { setAgentsError('Agent choices could not be loaded') }
  }, [])
  useEffect(() => { void loadAgents() }, [sessionId, loadAgents])
  // A terminal fills the viewport — it is not a scroll-away document. The
  // immersive header sizes the body for the compact row, so engage that row on
  // open (scroll the tall identity off) instead of leaving the pane overflowing
  // the page until the operator scrolls. Runs before paint, so there is no flash.
  useLayoutEffect(() => {
    if (!sessionId || loading) return
    const shell = document.querySelector('[data-archetype="workspace"]')
    if (shell instanceof HTMLElement) shell.scrollTop = shell.scrollHeight
  }, [sessionId, loading])
  const [viewParam, setViewParam] = useQueryState('view', 'active')
  const viewCount = (target: SessionView) => all.filter((item) => matchesView(item, target)).length
  const requestedView = (VIEWS as readonly string[]).includes(viewParam) ? viewParam as SessionView : 'active'
  // The attention segment only exists while something needs review.
  const view: SessionView = requestedView === 'review' && viewCount('review') === 0 ? 'active' : requestedView
  const visible = all.filter((item) => matchesView(item, view))
  const session = all.find((item) => item.id === sessionId)
  const ended = session?.state === 'exited' || session?.state === 'completed'
  const ownerAgentName = session?.owner.kind === 'agent' ? agents.find((agent) => agent.id === session.owner.id)?.name ?? session.owner.id : undefined
  // The operator is not the tab: any human client drives a human-owned live session.
  const writable = Boolean(session && session.owner.kind === 'human' && session.state === 'running')
  const controlStatus = ended ? 'Ended' : writable ? "You're driving" : ownerAgentName ? `Watching ${ownerAgentName}` : 'Watching'
  const status = session?.historyDeleted ? 'Output history deleted' : ended ? 'Ended' : streamStatus === controlStatus ? streamStatus : `${streamStatus} / ${controlStatus}`
  // One compact status chip sits beside the name instead of a stacked line:
  // green while you drive a live session, muted when ended, amber when the
  // stream is not yet connected.
  const connected = streamStatus.startsWith('Connected') || streamStatus === 'Completed'
  const chipTone = session?.historyDeleted || ended ? 'neutral' : !connected ? 'attention' : writable ? 'success' : 'neutral'
  const chipLabel = session?.historyDeleted ? 'Output deleted' : ended ? 'Ended' : !connected ? streamStatus.split(' / ')[0] : writable ? "You're driving" : ownerAgentName ? `You're watching ${ownerAgentName}` : "You're watching"
  const statusChip = session && <Badge size="xs" variant="solid" tone={chipTone} role="status" title={status}>{chipLabel}</Badge>
  useEffect(() => { setAssignment(session?.agentId ?? '') }, [session?.id, session?.agentId])
  async function operate(operation: string, extra: Record<string, unknown> = {}, targetId = sessionId) {
    const target = current.current.find((item) => item.id === targetId)
    if (!target) return
    setBusy(true); setError('')
    if (operation !== 'resize') epoch.current++
    try {
      const result = await api<Session>('/session', { id: target.id, operation, generation: target.generation, ...extra })
      if (result.id) update(result)
      await refresh()
      return true
    } catch (error) { setError(error instanceof Error ? error.message : 'Terminal operation failed'); return false }
    finally { setBusy(false) }
  }
  function input(data: string) {
    if (!session || !writable) return
    markActivity()
    const id = session.id, generation = session.generation, batch = epoch.current
    queue.current = queue.current.then(async () => {
      if (batch !== epoch.current) return
      const latest = current.current.find((entry) => entry.id === id)!
      if (latest.generation !== generation) return
      const updated = await api<Session>('/session', { id, operation: 'write', generation, sequence: latest.inputSequence + 1, data })
      update(updated)
    }).catch((error) => { epoch.current++; setError(error.message); void refresh() })
  }
  // Claim-on-type: typing while watching takes over, after a one-time confirm
  // that is remembered for CLAIM_GRACE_MS so it does not nag on every keystroke.
  const CLAIM_GRACE_MS = 15 * 60 * 1000
  const [claimData, setClaimData] = useState<string | null>(null)
  const activityAt = useRef(Date.now())
  const [idleReturn, setIdleReturn] = useState(false)
  const markActivity = useCallback(() => { activityAt.current = Date.now(); setIdleReturn(false) }, [])
  function claimGraceActive() { try { return Date.now() - Number(localStorage.getItem('bakin-terminal-claimed-at') ?? 0) < CLAIM_GRACE_MS } catch { return false } }
  function recordClaim() { try { localStorage.setItem('bakin-terminal-claimed-at', String(Date.now())) } catch { /* private mode */ } }
  async function takeAndSend(data: string, targetId: string) {
    markActivity()
    if (!await operate('take', {}, targetId)) return
    const latest = current.current.find((item) => item.id === targetId)
    if (!data || !latest || latest.owner.kind !== 'human' || latest.state !== 'running') return
    try {
      const updated = await api<Session>('/session', { id: targetId, operation: 'write', generation: latest.generation, sequence: latest.inputSequence + 1, data })
      update(updated)
    } catch (error) { setError(error instanceof Error ? error.message : 'Terminal input failed'); void refresh() }
  }
  function handleClaim(data: string) {
    const target = current.current.find((item) => item.id === sessionId)
    if (!target || target.owner.kind !== 'agent' || target.state !== 'running') return
    if (claimGraceActive()) { recordClaim(); void takeAndSend(data, target.id); return }
    setClaimData(data)
  }
  // Auto hand-back: while you drive a session with an assigned agent, going idle
  // returns control so the agent is never locked out. A 20s warning offers a
  // "Keep driving" escape. Navigating away hands back immediately.
  const IDLE_HANDBACK_MS = 2 * 60 * 1000
  const returnControl = useRef(() => {})
  returnControl.current = () => { void operate('return') }
  const drivingWithAgent = writable && Boolean(session?.agentId)
  useEffect(() => {
    if (!drivingWithAgent) return
    activityAt.current = Date.now()
    const timer = setInterval(() => {
      const idle = Date.now() - activityAt.current
      if (idle >= IDLE_HANDBACK_MS + 20_000) { returnControl.current(); setIdleReturn(false) }
      else if (idle >= IDLE_HANDBACK_MS) setIdleReturn(true)
    }, 5000)
    return () => clearInterval(timer)
  }, [drivingWithAgent, session?.id, IDLE_HANDBACK_MS])
  // Hand back immediately when leaving a session you were driving.
  const leaving = useRef<{ id: string } | null>(null)
  useEffect(() => {
    const prev = leaving.current
    if (prev && prev.id !== sessionId) void api('/session', { id: prev.id, operation: 'return' }).catch(() => {})
    leaving.current = drivingWithAgent && session ? { id: session.id } : null
  })
  useEffect(() => () => { if (leaving.current) void api('/session', { id: leaving.current.id, operation: 'return' }).catch(() => {}) }, [])
  async function setup() {
    setBusy(true); setError('')
    try { await api('/service', {}); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : 'Service setup failed') }
    finally { setBusy(false) }
  }
  async function reopen(target: Session) {
    // A dead session cannot be reconnected — there is no live process. Reopen
    // starts a fresh session in the same directory (reusing an existing
    // checkout, never minting a second worktree) with the same assignment.
    setBusy(true); setError('')
    try {
      const created = await api<Session>('/sessions', { title: target.title, cwd: target.cwd, program: target.program, checkout: 'existing', agentId: target.agentId || undefined, taskId: target.taskId || undefined, projectId: target.projectId || undefined })
      update(created); router.push(`/terminal/${encodeURIComponent(created.id)}`)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not reopen session') }
    finally { setBusy(false) }
  }
  const newTerminal = <Tooltip><TooltipTrigger render={<Button size="sm" onClick={() => setCreating(true)} disabled={!serviceReady || Boolean(loadError) || busy} focusableWhenDisabled />}><Plus size={16} />New terminal</TooltipTrigger><TooltipContent>New terminal. Create a persistent shell or coding CLI session.</TooltipContent></Tooltip>
  const back = <Tool label="Back to terminals" description="Return to the session list." render={<Button size="icon-sm" variant="ghost" aria-label="Back to terminals" role="link" nativeButton={false} render={<PluginLink to="/terminal" />} />}><ArrowLeft size={16} /></Tool>
  const state = loading ? <SystemState kind="loading" scope="page" title="Loading terminals" description="Checking terminal service and sessions." />
    : loadError && all.length === 0 ? <SystemState kind="error" scope="page" title="Terminals could not be loaded" description={loadError} action={<Button variant="outline" onClick={() => void refresh()}><RotateCw size={16} />Retry</Button>} />
    : !serviceReady && all.length === 0 ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="Terminal service is not set up" description="The persistent terminal service is unavailable on this Bakin instance." action={<Button disabled={busy} onClick={() => void setup()}><Play size={16} />Set up service</Button>} />
    : all.length === 0 ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="No terminals yet" description="No terminal sessions have been created." action={newTerminal} /> : undefined
  const feedback = <>
    {loadError && all.length > 0 && <SystemState kind="error" scope="inline" title="Terminals could not be refreshed" description={loadError} action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RotateCw size={16} />Retry</Button>} />}
    {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
  </>
  const controls = session && <Inline gap="dense" wrap={false} aria-label="Terminal controls">
            <Popover>
              <Tool label="Session details" description="View the working directory, agent assignment, and linked work." render={<PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Session details" />} />}><Info size={16} /></Tool>
              <PopoverContent align="end">
                <Stack gap="item">
                  <PopoverTitle>Session details</PopoverTitle>
                  <Stack gap="dense">
                    <Text weight="semibold">{session.title}</Text>
                    <Text size="meta" tone="muted" mono>{session.cwd}</Text>
                    <Text size="meta" tone="muted">{session.program} / {session.state}</Text>
                    <Text size="meta" tone="muted">{status}</Text>
                    {session.worktreePath && <Badge size="xs" variant="outline">Worktree retained</Badge>}
                  </Stack>
                  <Inline gap="dense">
                    <div className="min-w-0 flex-1"><AgentSelect className="w-full" ariaLabel="Assigned agent" value={assignment} onValueChange={setAssignment} agents={agentChoices} allowNone disabled={busy || Boolean(agentsError)} /></div>
                    <Tool label="Assign agent" description="Apply the selected agent to this session." disabled={busy || Boolean(agentsError) || assignment === (session.agentId ?? '')} onClick={() => void operate('assign', { agentId: assignment || undefined })}><UserRoundCheck size={16} /></Tool>
                  </Inline>
                  {agentsError && <SystemState kind="error" scope="inline" title={agentsError} description="Current assignment is unchanged." action={<Button size="sm" variant="outline" onClick={() => void loadAgents()}>Retry agents</Button>} />}
                  {session.taskId && <PluginLink to={`/tasks?taskId=${encodeURIComponent(session.taskId)}`}><CornerDownLeft size={14} />Task {session.taskId}</PluginLink>}
                  {session.projectId && <PluginLink to={`/projects/${encodeURIComponent(session.projectId)}`}><CornerDownLeft size={14} />Project {session.projectId}</PluginLink>}
                </Stack>
              </PopoverContent>
            </Popover>
            {ended
              ? <Tool label="Reopen" description="Start a fresh session in the same directory. Ended sessions cannot be reconnected." disabled={busy} onClick={() => void reopen(session)}><RotateCw size={16} /></Tool>
              : <>
                <Tool label="Drive" description={writable ? "You're already driving this session." : `Take over keyboard input.${ownerAgentName ? ` ${ownerAgentName} will pause sending input.` : ''} The running program is not interrupted.`} disabled={busy || writable} onClick={() => void operate('take')}><Hand size={16} /></Tool>
                <Tool label={ownerAgentName ? `Let ${ownerAgentName} continue` : 'Let the agent continue'} description={!session.agentId ? 'Assign an enabled agent first.' : `Hand keyboard input back to ${ownerAgentName ?? 'the assigned agent'}.`} disabled={busy || !session.agentId || !writable} onClick={() => void operate('return')}><Play size={16} /></Tool>
                <Tool label="Interrupt process" description="Send Ctrl+C to the foreground program. You must be driving." disabled={busy || !writable} onClick={() => input('\x03')}><Square size={16} /></Tool>
              </>}
            <SessionActions session={session} busy={busy} onOperate={(operation, id) => void operate(operation, {}, id)} onConfirm={setConfirm}>
                <DropdownMenuCheckboxItem checked={captureTab} onCheckedChange={setCaptureTab} disabled={session.historyDeleted}>Send Tab to terminal</DropdownMenuCheckboxItem>
                <DropdownMenuItem disabled={session.historyDeleted} onClick={() => setAttempt((value) => value + 1)}><RotateCw size={16} />Reconnect terminal</DropdownMenuItem>
                <DropdownMenuSeparator />
            </SessionActions>
        </Inline>
  return <TooltipProvider>{!sessionId ? <Page data-terminal-ui-ready={!loading ? '' : undefined}>
    <PageHeader title="Terminal" meta={!loading && !loadError && serviceReady ? <Badge size="xs" variant="outline">{all.filter((item) => item.state === 'running').length} running</Badge> : undefined} actions={all.length > 0 ? newTerminal : undefined} />
    <PageBody label="Terminal sessions">
      {feedback}
      {state ?? <Stack gap="item" align="start" className="min-h-0 w-full flex-1">
        <SegmentedControl
          size="sm"
          ariaLabel="Session view"
          value={view}
          onValueChange={setViewParam}
          options={[
            { value: 'active', label: 'Active' },
            ...(viewCount('review') > 0 ? [{ value: 'review' as const, label: 'Needs review' }] : []),
            { value: 'completed', label: 'Completed' },
            { value: 'all', label: 'All' },
          ]}
        />
        {visible.length === 0 ? <SystemState className="w-full" kind="no-results" scope="page" title="No sessions in this view" description="Sessions in other states are hidden by the current view." action={<Button variant="outline" onClick={() => setViewParam('all')}>Show all sessions</Button>} /> : <DataTable
        className="w-full"
        label="Terminal sessions"
        rows={visible}
        rowKey={(item) => item.id}
        defaultSort={{ field: 'activity', dir: 'desc' }}
        onRowActivate={(item) => router.push(`/terminal/${encodeURIComponent(item.id)}`)}
        rowActivateLabel={(item) => `Open terminal: ${item.title}`}
        columns={[
          { key: 'title', header: 'Session', sortable: true, sortValue: (item) => item.title, headClassName: 'w-1/4', cell: (item) => <PluginLink to={`/terminal/${encodeURIComponent(item.id)}`} aria-label={`Open terminal: ${item.title}`}><Text weight="semibold">{item.title}</Text></PluginLink> },
          { key: 'program', header: 'Program', sortable: true, sortValue: (item) => item.program },
          { key: 'agent', header: 'Agent', sortable: true, sortValue: (item) => item.agentId ? agentChoices.find((agent) => agent.id === item.agentId)?.name ?? item.agentId : null, cell: (item) => {
            if (!item.agentId) return <Text size="meta" tone="muted">Unassigned</Text>
            const choice = agentChoices.find((agent) => agent.id === item.agentId)
            const name = choice?.name ?? item.agentId
            return <Inline gap="dense" wrap={false} className="min-w-0"><AgentAvatar size="xs" decorative agent={{ id: item.agentId, name, imageSrc: choice?.imageSrc, color: choice?.color }} /><Text size="meta" className="truncate">{name}</Text></Inline>
          } },
          { key: 'state', header: 'Status', sortable: true, sortValue: (item) => item.state === 'running' ? 0 : item.state === 'exited' ? 1 : 2, cell: (item) => <Stack gap="dense" align="start"><Badge size="xs" variant="outline">{item.state === 'running' ? 'Running' : item.state === 'exited' ? 'Exited' : 'Completed'}</Badge>{item.worktreePath && <Badge size="xs" variant="outline">Worktree retained</Badge>}</Stack> },
          { key: 'activity', header: 'Last activity', sortable: true, sortValue: (item) => item.lastActivityAt, cell: (item) => <Text size="meta" tone="muted" title={new Date(item.lastActivityAt).toLocaleString()}>{formatAge(new Date(item.lastActivityAt))}</Text> },
          { key: 'cwd', header: 'Working directory', headClassName: 'w-1/3', cell: (item) => <Text size="meta" tone="muted" mono>{item.cwd}</Text> },
          { key: 'actions', header: 'Actions', hideLabel: true, align: 'end', headClassName: 'w-(--bakin-layout-size-row)', cell: (item) => <SessionActions session={item} busy={busy} label={`Actions for ${item.title}`} allowTake onOperate={(operation, id) => void operate(operation, {}, id)} onConfirm={setConfirm} /> },
        ]}
      />}
      </Stack>}
    </PageBody>
  </Page> : <WorkspacePage mode="immersive" className="terminal-page" data-terminal-ui-ready={!loading ? '' : undefined}>
    <WorkspacePageHeader>
        <PageHeader navigation={back} eyebrow="Terminal" title={session?.title ?? 'Terminal'} meta={statusChip} actions={controls} />
    </WorkspacePageHeader>
    <WorkspacePageCompactHeader navigation={back} title={<Inline gap="dense" wrap={false} className="min-w-0 items-center"><span className="truncate">{session?.title ?? 'Terminal'}</span>{statusChip}</Inline>} action={controls} />
    <WorkspacePageBody>
      <Stack as="section" gap="none" className="min-h-0 flex-1 overflow-y-auto" aria-label="Selected terminal">
        {(loadError && all.length > 0 || error) && <Stack gap="item" className="shrink-0 p-bakin-4">
          {feedback}
        </Stack>}
        {state ?? (!session ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="Terminal not found" description="This session is not available." action={<Button variant="outline" nativeButton={false} render={<PluginLink to="/terminal" />}>Back to terminals</Button>} /> : <>
          {(!serviceReady || session.cleanupReason || (idleReturn && drivingWithAgent)) && <Stack gap="item" className="shrink-0 p-bakin-4">
          {!serviceReady && <SystemState kind="error" scope="inline" title="Terminal service unavailable" description="Existing sessions are retained." action={<Button disabled={busy} onClick={() => void setup()}>Set up service</Button>} />}
          {idleReturn && drivingWithAgent && <Alert tone="attention"><AlertDescription><Inline gap="dense" wrap className="items-center justify-between"><span>You've been idle — returning control to {ownerAgentName ?? 'the agent'} shortly.</span><Button size="sm" variant="outline" onClick={markActivity}>Keep driving</Button></Inline></AlertDescription></Alert>}
          {session.cleanupReason && <Alert tone="attention"><AlertDescription>{session.cleanupReason}</AlertDescription></Alert>}
          </Stack>}
          <Separator />
          {session.historyDeleted ? <SystemState kind="initial-empty" scope="page" title="Output history deleted" description="Session metadata is retained." /> : <TerminalCanvas key={session.id} session={session} writable={writable} captureTab={captureTab} attempt={attempt} onStatus={setStreamStatus} onInput={input} onClaim={handleClaim} onSession={update} onResize={(cols, rows) => operate('resize', { cols, rows })} />}
        </>)}
      </Stack>
    </WorkspacePageBody>
  </WorkspacePage>}
    <NewSession open={creating} onOpenChange={setCreating} onCreated={(created) => { update(created); router.push(`/terminal/${encodeURIComponent(created.id)}`) }} />
    <ConfirmDialog open={confirm !== null} busy={busy} error={error || undefined} onCancel={() => setConfirm(null)}
      title={confirm?.operation === 'terminate' ? 'Terminate this session?' : confirm?.operation === 'delete' ? 'Delete this session?' : 'Delete output history?'}
      description={`${all.find((item) => item.id === confirm?.id)?.title ?? 'Terminal'}. ${confirm?.operation === 'terminate' ? 'This stops the running process. Unfinished worktrees will be retained.' : confirm?.operation === 'delete' ? 'The session and all of its retained output will be permanently deleted.' : 'The retained terminal output will be permanently deleted. Session metadata is retained.'}`}
      confirmLabel={confirm?.operation === 'terminate' ? 'Terminate' : confirm?.operation === 'delete' ? 'Delete session' : 'Delete output'}
      onConfirm={async () => {
        if (!confirm) return
        const target = confirm
        if (!await operate(target.operation, {}, target.id)) return
        setConfirm(null)
        if (target.operation !== 'delete') return
        remove((id) => id === target.id)
        if (target.id === sessionId) router.push('/terminal')
      }} />
    <ConfirmDialog open={claimData !== null} busy={busy} error={error || undefined} onCancel={() => setClaimData(null)}
      title="Take over this session?"
      description={`${ownerAgentName ?? 'The agent'} will stop sending input until you hand control back. The running program keeps running.`}
      confirmLabel="Take over" confirmTone="primary"
      onConfirm={async () => {
        if (claimData === null || !sessionId) return
        const data = claimData
        setClaimData(null)
        recordClaim()
        await takeAndSend(data, sessionId)
      }} />
  </TooltipProvider>
}
export function TerminalPage(props: { sessionId?: string }) { return <Suspense><Workspace {...props} /></Suspense> }
