'use client'

/**
 * Project detail (D10): header, then a Conversation · Plan · Steps · Files
 * tab bar over one content column. The project conversation is the primary
 * surface: full width on its tab, and docked beside Plan/Steps/Files on
 * desktop. Exactly ONE ConversationPanel is mounted at a time — on the
 * Conversation tab, or in the expanded dock, never both; the shared
 * storageKey carries the composer draft across the remount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { formatAge } from '@makinbakin/sdk/utils'
import { emitPluginEvent, toast, useAgentList, useMainAgentId, useMediaQuery, usePluginEvent } from '@makinbakin/sdk/hooks'
import { useQueryState, useUnsavedChangesGuard } from '@makinbakin/sdk/navigation'
import { ConversationEmptyState, ConversationPanel, useConversationThread } from '@makinbakin/sdk/conversation'
import type { ConversationAgent } from '@makinbakin/sdk/conversation'
import {
  AgentSelect,
  ConfirmDialog,
  Page,
  PageBody,
  StatusMarker,
  useCollapsedAside,
} from '@makinbakin/sdk/patterns'
import { Button, Checkbox, Field, FieldLabel, Skeleton, SystemState, Tabs, TabsList, TabsTrigger, Text } from '@makinbakin/sdk/ui'
import { ChatDock } from './chat-dock'
import { ProjectHeader } from './project-header'
import { FilesTab } from './tabs/files-tab'
import { PlanTab } from './tabs/plan-tab'
import { StepsTab } from './tabs/steps-tab'
import { useChecklistDrafts } from '../hooks/use-checklist-drafts'
import { usePlanDraft } from '../hooks/use-plan-draft'
import { useProjectUploads } from '../hooks/use-project-uploads'
import { useProjectDetail } from '../hooks/use-project-detail'
import { useProjectHistory } from '../hooks/use-project-history'
import { projectRequest } from '../lib/project-api'
import type { PlanSnapshot, ProjectStatus, ProjectTask } from '../types'

const EMPTY_TASKS: ProjectTask[] = []

export const PROJECT_TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'plan', label: 'Plan' },
  { id: 'steps', label: 'Steps' },
  { id: 'files', label: 'Files' },
] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]['id']

/** Where a project opens when `?tab` is absent: what matters at its stage. */
export const DEFAULT_TAB: Record<ProjectStatus, ProjectTab> = {
  draft: 'conversation',
  active: 'steps',
  completed: 'files',
  archived: 'plan',
}

const isTab = (value: string): value is ProjectTab => PROJECT_TABS.some(tab => tab.id === value)

export function ProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const mainAgentId = useMainAgentId() ?? ''
  const detail = useProjectDetail(projectId)
  const { project, loading, error: loadError, refresh } = detail
  const history = useProjectHistory(projectId, project?.body)
  const plan = usePlanDraft(projectId, project, refresh)
  const checklist = useChecklistDrafts(projectId, project?.tasks ?? EMPTY_TASKS, refresh)
  const uploads = useProjectUploads(projectId, refresh)
  const desktop = useMediaQuery('(min-width: 1024px)')
  const [dockCollapsed, setDockCollapsed] = useCollapsedAside('projects:conversation-dock')
  const [tabParam, setTabParam] = useQueryState('tab', '')
  const [editParam, setEditParam] = useQueryState('edit', '')
  const [viewParam, setViewParam] = useQueryState('view', '')

  const agentList = useAgentList()
  const agents = useMemo(() => agentList.map(agent => ({
    id: agent.id,
    name: agent.name ?? agent.id,
    imageSrc: agent.headshot ?? null,
  })), [agentList])
  // The lead answers by default; the composer's picker is for one-off consults (D13).
  const [consultAgent, setConsultAgent] = useState<string | null>(null)
  const replyAgent = consultAgent ?? project?.owner ?? mainAgentId
  const replyAgentRef = useRef(replyAgent)
  replyAgentRef.current = replyAgent
  const leadAgent = useMemo<ConversationAgent>(() => {
    const id = project?.owner || mainAgentId
    const agent = agentList.find(candidate => candidate.id === id)
    return { id, name: agent?.name ?? (id || 'Agent'), ...(agent?.headshot ? { avatarUrl: agent.headshot } : {}) }
  }, [agentList, project?.owner, mainAgentId])

  const tab: ProjectTab = isTab(tabParam) ? tabParam : project ? DEFAULT_TAB[project.status] : 'conversation'
  const editing = tab === 'plan' && editParam === '1'
  const selectTab = (next: string) => {
    if (!isTab(next)) return
    // The stage default stays out of the URL.
    setTabParam(project && next === DEFAULT_TAB[project.status] ? '' : next)
    if (next !== 'plan') { setEditParam(''); setViewParam('') }
  }

  // ── "Plan updated" (D15): an agent wrote a revision the user has not seen.
  const planUnseen = Boolean(project && project.planUpdatedBy === 'agent' && project.planRevision > (project.planSeenRevision ?? 0))
  // Opening the Plan tab captures the comparison baseline for this VISIT
  // first — later revisions while it stays open never move it — then marks
  // the current revision seen. The baseline body is kept client-side too, so
  // history retention can never evict it mid-review.
  const [planBaseline, setPlanBaseline] = useState<number | undefined>(undefined)
  const [baselineSnapshot, setBaselineSnapshot] = useState<PlanSnapshot | undefined>(undefined)
  const planRevision = project?.planRevision
  const seenRevision = project?.planSeenRevision ?? 0
  useEffect(() => {
    if (tab !== 'plan') {
      setPlanBaseline(undefined)
      setBaselineSnapshot(undefined)
      return
    }
    if (planRevision !== undefined && planRevision > seenRevision) setPlanBaseline(current => current ?? seenRevision)
  }, [tab, planRevision, seenRevision])
  // Keep the baseline body BEFORE marking anything seen: once the revision is
  // seen, retention no longer pins that snapshot.
  const baselineReady = planBaseline !== undefined && (
    baselineSnapshot?.revision === planBaseline
    || (history.history !== null && !history.loading && !history.history.some(snapshot => snapshot.revision === planBaseline))
  )
  useEffect(() => {
    if (planBaseline === undefined || baselineSnapshot?.revision === planBaseline) return
    const kept = history.history?.find(snapshot => snapshot.revision === planBaseline)
    if (kept) setBaselineSnapshot(kept)
  }, [planBaseline, baselineSnapshot, history.history])
  useEffect(() => {
    if (tab !== 'plan' || !baselineReady || planRevision === undefined || planRevision <= seenRevision) return
    void projectRequest(`${encodeURIComponent(projectId)}/plan/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: planRevision }),
    }).then(() => refresh()).catch(() => {})
  }, [tab, baselineReady, planRevision, seenRevision, projectId, refresh])
  const reviewPlanChanges = () => {
    selectTab('plan')
    setViewParam('changes')
  }

  const showDock = desktop && tab !== 'conversation'
  // Nothing is "visible" until the project has loaded: the tab default is a
  // guess until then, and marking a reply seen early would clear its dot.
  const panelVisible = Boolean(project) && (tab === 'conversation' || (showDock && !dockCollapsed))
  const [unread, setUnread] = useState(false)
  const panelVisibleRef = useRef(panelVisible)
  panelVisibleRef.current = panelVisible

  // ── Conversation: the server owns the transcript AND the turn (bakin#703).
  const markSeen = useCallback(() => {
    if (document.visibilityState !== 'visible') return
    void fetch(`/api/plugins/projects/${encodeURIComponent(projectId)}/brainstorm/seen`, { method: 'POST' })
      .then(() => emitPluginEvent({ event: 'projects.brainstorm.seen', projectId }))
      .catch(() => {})
  }, [projectId])

  const thread = useConversationThread({
    threadKey: projectId,
    events: {
      chunk: 'projects.brainstorm.chunk',
      done: 'projects.brainstorm.done',
      error: 'projects.brainstorm.error',
    },
    keyOf: useCallback((payload: Record<string, unknown>) => payload.projectId, []),
    load: useCallback(async (key: string) => {
      const res = await fetch(`/api/plugins/projects/${encodeURIComponent(key)}`)
      if (!res.ok) return null
      const data = await res.json()
      return {
        messages: Array.isArray(data.project?.brainstormMessages) ? data.project.brainstormMessages : [],
        streaming: data.project?.brainstormStreaming === true,
        ...(typeof data.project?.brainstormStreamingText === 'string' ? { streamingText: data.project.brainstormStreamingText } : {}),
      }
    }, []),
    post: useCallback(async (key: string, content: string) => {
      const res = await fetch(`/api/plugins/projects/${encodeURIComponent(key)}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: key, prompt: content, agent: replyAgentRef.current }),
      })
      if (res.ok) return { ok: true }
      const body = await res.json().catch(() => ({}))
      return { ok: false, status: res.status, ...(body.error ? { error: String(body.error) } : {}) }
    }, []),
    // The agent may have edited the plan or steps; a reply landing out of
    // sight marks the collapsed dock unread.
    onSettled: useCallback(() => {
      void refresh()
      if (panelVisibleRef.current) markSeen()
      else setUnread(true)
    }, [refresh, markSeen]),
  })

  useEffect(() => {
    if (thread.sendError) toast(thread.sendError, 'error')
  }, [thread.sendError])

  useEffect(() => {
    if (!panelVisible) return
    setUnread(false)
    markSeen()
  }, [panelVisible, markSeen])
  // An unseen reply from before this visit shows on the collapsed dock too.
  const hydratedUnread = project?.brainstormUnread === true
  useEffect(() => {
    if (hydratedUnread && !panelVisibleRef.current) setUnread(true)
  }, [hydratedUnread])

  // Mid-turn plan/step edits land as tool activity — refresh immediately.
  usePluginEvent('projects.changed', (payload) => { if (payload.projectId === projectId) void refresh() })
  usePluginEvent('projects.brainstorm.chunk', (payload) => {
    if (payload.projectId !== projectId) return
    if ((payload.chunk as { type?: string } | undefined)?.type === 'tool') void refresh()
  })

  const abort = useCallback(() => {
    void fetch(`/api/plugins/projects/${encodeURIComponent(projectId)}/ask/abort`, { method: 'POST' }).catch(() => {})
  }, [projectId])
  const retry = useCallback(() => {
    const lastUser = [...thread.messages].reverse().find(message => message.kind === 'user')
    if (lastUser?.kind === 'user' && lastUser.content) void thread.send(lastUser.content)
  }, [thread])

  // ── Leaving with unsaved plan or step edits.
  const [leaving, setLeaving] = useState(false)
  const [exitSaving, setExitSaving] = useState(false)
  const [exitError, setExitError] = useState<string | null>(null)
  const exitGuard = useUnsavedChangesGuard({
    hasUnsavedChanges: !leaving && (plan.dirty || checklist.dirty || plan.saving || checklist.saving),
    saving: plan.saving || checklist.saving || exitSaving,
    onCancel: () => setLeaving(true),
    saveLabel: 'Save all and leave',
    description: 'Save your plan and step edits, discard them, or stay here. Your message draft is kept and will not be sent.',
    error: exitError,
    onSaveAndExit: async () => {
      setExitError(null)
      if (!plan.validate() || !checklist.validate()) { setExitError('Resolve the highlighted conflicts before leaving. Choose Cancel to review them.'); return false }
      setExitSaving(true)
      try {
        if (!await plan.save()) { setExitError('Plan edits remain unsaved. Choose Cancel to review conflicts, or retry.'); return false }
        if (!await checklist.saveAll()) { setExitError('The plan is saved. Some step edits remain unsaved; retry saves only the unfinished work.'); return false }
        return !plan.isDirty() && !checklist.isDirty()
      } finally { setExitSaving(false) }
    },
    onDiscardAndExit: () => { plan.discard(); checklist.discardAll() },
  })
  useEffect(() => { if (leaving) onBack() }, [leaving, onBack])

  // ── Delete.
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteLinkedTasks, setDeleteLinkedTasks] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const linkedTaskCount = project?.tasks.filter(task => task.taskId).length ?? 0
  const handleDelete = async () => {
    if (deleting || plan.saving || checklist.saving) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await projectRequest(encodeURIComponent(projectId), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteLinkedTasks: linkedTaskCount > 0 && deleteLinkedTasks }),
      })
      plan.discard(); checklist.discardAll()
      setDeleteOpen(false)
      setLeaving(true)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'The project could not be deleted. Try again.')
    } finally {
      setDeleting(false)
    }
  }

  if (loading && !project) {
    return (
      <Page>
        <PageBody>
          <Button variant="ghost" onClick={onBack}>Back to projects</Button>
          <SystemState
            kind="loading"
            scope="section"
            title="Loading project"
            description="Project details will appear here."
            preview={(
              <div className="flex flex-col gap-bakin-3">
                <Skeleton className="h-bakin-6 w-60" />
                <Skeleton className="h-bakin-4 w-40" />
                <Skeleton className="h-40 w-full" />
              </div>
            )}
          />
        </PageBody>
      </Page>
    )
  }
  if (!project) {
    const missing = loadError?.status === 404
    return (
      <Page>
        <PageBody>
          <Button variant="ghost" onClick={onBack}>Back to projects</Button>
          <SystemState
            kind="error"
            recovery={missing ? 'unavailable' : 'available'}
            scope="section"
            title={missing ? 'Project not found' : 'Project could not be loaded'}
            description={missing ? 'This project may have been deleted or its file moved.' : loadError?.message ?? 'Try loading this project again.'}
            action={missing ? undefined : <Button variant="outline" onClick={() => { void refresh() }}>Try again</Button>}
          />
        </PageBody>
      </Page>
    )
  }

  const inDock = tab !== 'conversation'
  const panel = (
    <ConversationPanel
      messages={thread.messages}
      liveChunks={thread.liveChunks}
      streaming={thread.streaming}
      onSend={thread.send}
      onAbort={abort}
      onRetry={retry}
      agent={leadAgent}
      agentControl={(
        <AgentSelect
          value={replyAgent}
          onValueChange={setConsultAgent}
          agents={agents}
          ariaLabel="Reply agent"
          size="sm"
          variant="filled"
        />
      )}
      storageKey={`project:${projectId}`}
      attachments={uploads}
      showHeader={false}
      fitParent
      chrome="top-divider"
      autoFocus={!inDock}
      placeholder={`Message ${leadAgent.name}…`}
      emptyState={(
        <ConversationEmptyState
          headingLevel={2}
          title={`Shape this project with ${leadAgent.name}`}
          description="Talk it through — your lead asks one question at a time, pokes holes, and drafts the plan once it is clear."
        />
      )}
    />
  )

  // The notice sits with the conversation wherever it is shown; nothing is
  // injected into the transcript.
  const conversation = (
    <div className="flex min-h-0 flex-1 flex-col">
      {planUnseen ? (
        <div data-slot="plan-updated-notice" className="flex shrink-0 flex-wrap items-center gap-bakin-2 border-b border-bakin-border-subtle px-bakin-3 py-bakin-2">
          <StatusMarker tone="accent" />
          <Text size="meta">Plan updated{project.planUpdatedAt ? ` ${formatAge(project.planUpdatedAt)}` : ''}</Text>
          <Button type="button" variant="ghost" size="xs" onClick={reviewPlanChanges}>Review changes</Button>
        </div>
      ) : null}
      {panel}
    </div>
  )

  const content = tab === 'plan' ? (
    <PlanTab
      project={project}
      history={history}
      draft={plan}
      editing={editing}
      onEditingChange={next => setEditParam(next ? '1' : '')}
      view={viewParam === 'changes' ? 'changes' : 'rendered'}
      onViewChange={next => setViewParam(next === 'changes' ? 'changes' : '')}
      compareRevision={planBaseline}
      baselineSnapshot={baselineSnapshot}
      onRestored={refresh}
    />
  ) : tab === 'steps' ? (
    <StepsTab project={project} checklist={checklist} />
  ) : tab === 'files' ? (
    <FilesTab project={project} onChanged={refresh} />
  ) : null

  return (
    <Page scroll="contained" data-slot="project-detail">
      {loadError ? (
        <SystemState kind="error" recovery="available" scope="inline" title="Project could not be refreshed" description={loadError.message} action={<Button variant="outline" size="sm" onClick={() => { void refresh() }}>Try again</Button>} />
      ) : null}
      {exitGuard.dialog}
      <ProjectHeader
        project={project}
        agents={agents}
        onBack={exitGuard.requestExit}
        onChanged={refresh}
        onDelete={() => { setDeleteError(null); setDeleteOpen(true) }}
      />
      <PageBody gap="content">
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Tabs value={tab} onValueChange={selectTab}>
              <TabsList variant="underline" aria-label="Project sections">
                {PROJECT_TABS.map(entry => (
                  <TabsTrigger key={entry.id} value={entry.id} id={`project-tab-${entry.id}`} aria-controls={`project-panel-${entry.id}`}>
                    {entry.label}
                    {entry.id === 'plan' && planUnseen ? <StatusMarker tone="accent" label="updated" /> : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div
              role="tabpanel"
              id={`project-panel-${tab}`}
              aria-labelledby={`project-tab-${tab}`}
              data-slot="project-tab-panel"
              // Content tabs scroll here, so the panel takes keyboard focus;
              // the conversation tab's panel owns its own scroll and controls.
              {...(tab === 'conversation' ? {} : { tabIndex: 0 })}
              className={tab === 'conversation'
                ? 'flex min-h-0 flex-1 flex-col'
                : 'flex min-h-0 flex-1 flex-col overflow-y-auto py-bakin-4 focus-visible:outline-2 focus-visible:outline-bakin-focus-ring focus-visible:-outline-offset-2 lg:pr-bakin-4'}
            >
              {tab === 'conversation' ? conversation : content}
              {!desktop && tab !== 'conversation' ? (
                <div className="sticky bottom-0 flex justify-end bg-bakin-canvas-default pt-bakin-3">
                  <Button type="button" onClick={() => selectTab('conversation')}>
                    <MessageSquare aria-hidden="true" />
                    Ask {leadAgent.name}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          {showDock ? (
            <ChatDock
              agent={leadAgent}
              collapsed={dockCollapsed}
              onCollapsedChange={setDockCollapsed}
              working={thread.streaming}
              unread={unread}
            >
              {dockCollapsed ? null : conversation}
            </ChatDock>
          ) : null}
        </div>
      </PageBody>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete project?"
        description={<>This will permanently delete <Text weight="medium">{project.title}</Text>, its plan and its steps.</>}
        confirmLabel="Delete"
        busyLabel="Deleting..."
        confirmTone="danger"
        busy={deleting || plan.saving || checklist.saving}
        error={deleteError}
        onConfirm={() => { void handleDelete() }}
        onCancel={() => {
          if (deleting) return
          setDeleteOpen(false)
          setDeleteLinkedTasks(false)
        }}
      >
        {linkedTaskCount > 0 && (
          <div className="flex flex-col gap-bakin-2">
            <Text as="p" size="meta" tone="muted">
              This project has <Text size="meta" weight="medium">{linkedTaskCount}</Text> linked board {linkedTaskCount === 1 ? 'task' : 'tasks'}. Unchecked, {linkedTaskCount === 1 ? 'it stays' : 'they stay'} on the board.
            </Text>
            <Field orientation="horizontal" name="deleteLinkedTasks">
              <Checkbox checked={deleteLinkedTasks} onCheckedChange={(checked: boolean) => setDeleteLinkedTasks(checked === true)} />
              <FieldLabel>Also delete {linkedTaskCount === 1 ? 'the linked board task' : 'the linked board tasks'}</FieldLabel>
            </Field>
          </div>
        )}
      </ConfirmDialog>
    </Page>
  )
}
