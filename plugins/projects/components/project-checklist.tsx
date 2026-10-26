import { useState, type FormEvent } from 'react'
import { Plus, Trash, ChevronRight, Send } from 'lucide-react'
import { Alert, AlertDescription, Button, Checkbox, Field, FieldLabel, Form, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Progress, Switch, SystemState, Text, Textarea, buttonVariants } from '@makinbakin/sdk/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { ListRow, ListRowActions, ListRows, StatusBadge } from '@makinbakin/sdk/patterns'
import { PluginLink } from '@makinbakin/sdk/navigation'
import { useAgentList } from '@makinbakin/sdk/hooks'
import type { ProjectTask, ResolvedBoardTask } from '../types'
import type { ChecklistModel } from '../hooks/use-checklist-drafts'

const columns: Record<string, string> = { backlog: 'Backlog', todo: 'To do', inProgress: 'In progress', review: 'In review', done: 'Done', archived: 'Archived', blocked: 'Blocked' }
function ErrorNotice({ message }: { message?: string }) {
  return message ? <Alert tone="danger"><AlertDescription>{message}</AlertDescription></Alert> : null
}
/** Board state in words (D16): "In progress · Roscoe", "Done · board". */
export function boardStateLabel(resolved: ResolvedBoardTask, agentName?: string): string {
  return `${columns[resolved.column] ?? resolved.column} · ${agentName ?? 'board'}`
}

function TaskItem({ item, resolved, model, agentNames }: { item: ProjectTask; resolved: ResolvedBoardTask | null | undefined; model: ChecklistModel; agentNames: ReadonlyMap<string, string> }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const draft = model.descriptions[item.id]
  const busy = model.busy[item.id]
  const value = draft?.value ?? item.description ?? ''
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void model.saveDescription(item.id) }
  return <ListRow>
    <div className="flex min-w-0 flex-wrap items-start gap-bakin-2">
      {/* A linked step completes from its board task (D16a): read-only here. */}
      <Checkbox checked={item.checked} disabled={busy || Boolean(item.taskId)} onCheckedChange={(checked: boolean) => { void model.mutate(item, 'toggle', checked === true) }} aria-label={item.taskId ? `${item.title} completes from its board task` : `Complete ${item.title}`} />
      <Button type="button" variant="ghost" size="inline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1">
        <ChevronRight aria-hidden="true" className={`shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        <Text size="meta" tone={item.checked ? 'muted' : 'default'} className={`min-w-0 whitespace-normal break-words ${item.checked ? 'line-through' : ''}`}>{item.title}</Text>
      </Button>
      {item.taskId && resolved && <Text size="meta" tone="muted">{boardStateLabel(resolved, resolved.agent ? agentNames.get(resolved.agent) ?? resolved.agent : undefined)}</Text>}
      {item.taskId && resolved === null && <StatusBadge tone="attention" size="xs">Board task missing</StatusBadge>}
      <ListRowActions reveal="always">
        {item.taskId && resolved ? (
          <PluginLink to={`/tasks?taskId=${encodeURIComponent(item.taskId)}`} aria-label={`Open task for ${item.title}`} className={buttonVariants({ variant: 'ghost', size: 'xs' })}>Open task</PluginLink>
        ) : null}
        {!item.taskId && <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => { void model.mutate(item, 'promote') }} aria-label={`Send ${item.title} to the board`}><Send aria-hidden="true" />Send to board</Button>}
        <Button type="button" variant="ghost" size="icon-xs" disabled={busy || (draft && draft.value !== draft.baseline)} onClick={() => { void model.mutate(item, 'remove') }} aria-label={`Remove ${item.title}`}><Trash aria-hidden="true" /></Button>
      </ListRowActions>
    </div>
    <ErrorNotice message={model.errors[item.id]} />
    {expanded && <div className="min-w-0 pt-bakin-3">
      {editing ? <Form aria-label={`Edit details for ${item.title}`} onSubmit={submit} busy={busy}>
        <Field name={`description-${item.id}`}>
          <FieldLabel>Details for {item.title}</FieldLabel>
          <Textarea size="sm" variant="outlined" autoSize minRows={2} maxRows={6} value={value}
            aria-label={`Details for ${item.title}`} onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => model.editDescription(item, event.target.value)} />
        </Field>
        {draft?.conflict && <Alert tone="attention"><AlertDescription>
          <Text as="p">The description changed while you were editing. Latest: {draft.latest || '(empty)'}</Text>
          <div className="flex flex-wrap gap-bakin-2">
            <Button type="button" size="sm" variant="outline" onClick={() => model.resolveDescription(item.id, 'latest')}>Use latest description</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => model.resolveDescription(item.id, 'mine')}>Keep my description</Button>
          </div>
        </AlertDescription></Alert>}
        <div className="flex flex-wrap gap-bakin-2">
          <Button type="submit" size="sm" disabled={busy || !draft || draft.value === draft.baseline}>{busy ? 'Saving…' : 'Save details'}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { model.discardDescription(item.id); setEditing(false) }}>Discard details</Button>
        </div>
      </Form> : <Button type="button" variant="ghost" size="inline" className="w-full whitespace-normal" onClick={() => { model.editDescription(item, value); setEditing(true) }} aria-label={`Edit details for ${item.title}`}>
        <Text size="meta" tone="muted">{value || 'Add details…'}</Text>
      </Button>}
    </div>}
  </ListRow>
}
export function ProjectChecklist({ projectId, tasks, resolvedTasks, model }: {
  projectId: string
  tasks: ProjectTask[]
  resolvedTasks: Record<string, ResolvedBoardTask | null>
  model: ChecklistModel
}) {
  const agentList = useAgentList()
  const agentNames = new Map(agentList.map(agent => [agent.id, agent.name ?? agent.id]))
  const preference = `projects-hide-completed:${projectId}`
  const [hideCompleted, setHideCompleted] = useState(() => { try { return localStorage.getItem(preference) === 'true' } catch { return false } })
  const completed = tasks.filter(task => task.checked).length
  const visible = tasks.filter(task => !hideCompleted || !task.checked || model.descriptions[task.id])
  const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0
  return <Stack gap="item">
    <div className="flex flex-wrap items-center justify-between gap-bakin-3">
      <h2>Steps</h2>
      {completed > 0 && <Field orientation="horizontal" name="hide-completed"><Switch size="sm" checked={hideCompleted} onCheckedChange={(value: boolean) => { setHideCompleted(value); try { localStorage.setItem(preference, String(value)) } catch { /* private mode */ } }} /><FieldLabel>Hide done ({completed})</FieldLabel></Field>}
    </div>
    {tasks.length > 0 && <div className="flex flex-col gap-bakin-1">
      <Progress value={percent} aria-label="Steps progress" />
      <Text size="meta" tone="muted">{completed} of {tasks.length} steps done</Text>
    </div>}
    {tasks.length === 0 ? <SystemState kind="initial-empty" scope="inline" headingLevel={3} title="No steps yet" description="Steps appear once the plan takes shape — or add one." />
      : visible.length === 0 ? <Text size="meta" tone="muted">All done steps are hidden.</Text>
      : <ListRows variant="separated" size="sm" aria-label="Project steps">{visible.map(item => <TaskItem key={item.instanceId ?? item.id} item={item} resolved={item.taskId ? resolvedTasks[item.taskId] : undefined} model={model} agentNames={agentNames} />)}</ListRows>}
    {Object.entries(model.descriptions).filter(([, draft]) => draft.removed && draft.value !== draft.baseline).map(([id, draft]) => <Alert key={id} tone="attention"><AlertDescription>
      Details for “{draft.item.title}” remain unsaved because the item was removed or replaced.
      <Button type="button" size="sm" variant="outline" onClick={() => model.discardDescription(id)}>Discard removed item draft</Button>
    </AlertDescription></Alert>)}
    <Form aria-label="Add a step" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void model.add() }} busy={model.busy.add}>
      <InputGroup size="md" variant="outlined">
        <InputGroupInput value={model.newTitle} onChange={(event: React.ChangeEvent<HTMLInputElement>) => model.setNewTitle(event.target.value)} placeholder="Add a step…" aria-label="Add a step" />
        <InputGroupAddon align="inline-end"><InputGroupButton type="submit" size="icon-xs" disabled={model.busy.add || model.addIntent?.deleted || (!model.newTitle.trim() && !model.addIntent)} aria-label="Add step"><Plus aria-hidden="true" /></InputGroupButton></InputGroupAddon>
      </InputGroup>
      {model.addIntent && model.addIntent.raw !== model.newTitle && <Text size="meta">Confirming the earlier add for “{model.addIntent.title}” first. Your newer draft is kept.</Text>}
      <ErrorNotice message={model.errors.add} />
      {model.addIntent?.deleted && <Button type="button" size="sm" variant="outline" onClick={model.discardAdd}>Discard removed step draft</Button>}
    </Form>
  </Stack>
}
