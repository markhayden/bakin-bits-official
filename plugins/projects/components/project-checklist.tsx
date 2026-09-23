import { useState, type FormEvent } from 'react'
import { Plus, Trash2, Link2, ChevronRight } from 'lucide-react'
import { Alert, AlertDescription, Button, Checkbox, Field, FieldLabel, Form, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Switch, SystemState, Text, Textarea } from '@makinbakin/sdk/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { ListRow, ListRowActions, ListRows, StatusBadge } from '@makinbakin/sdk/patterns'
import { PluginLink } from '@makinbakin/sdk/navigation'
import type { ProjectTask } from '../types'
import type { useChecklistDrafts } from '../hooks/use-checklist-drafts'

type ChecklistModel = ReturnType<typeof useChecklistDrafts>
const columns: Record<string, string> = { backlog: 'Backlog', todo: 'To do', inProgress: 'In progress', review: 'In review', done: 'Done', archived: 'Archived', blocked: 'Blocked' }
function ErrorNotice({ message }: { message?: string }) {
  return message ? <Alert tone="danger"><AlertDescription>{message}</AlertDescription></Alert> : null
}
function TaskItem({ item, resolved, model }: { item: ProjectTask; resolved: { column: string; title: string } | null | undefined; model: ChecklistModel }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const draft = model.descriptions[item.id]
  const busy = model.busy[item.id]
  const value = draft?.value ?? item.description ?? ''
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void model.saveDescription(item.id) }
  return <ListRow>
    <div className="flex min-w-0 flex-wrap items-start gap-bakin-2">
      <Checkbox checked={item.checked} disabled={busy} onCheckedChange={(checked: boolean) => { void model.mutate(item, 'toggle', checked === true) }} aria-label={`Complete ${item.title}`} />
      <Button type="button" variant="ghost" size="inline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1">
        <ChevronRight aria-hidden="true" className={`shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        <Text size="meta" tone={item.checked ? 'muted' : 'default'} className={`min-w-0 whitespace-normal break-words ${item.checked ? 'line-through' : ''}`}>{item.title}</Text>
      </Button>
      {item.taskId && resolved && <PluginLink to={`/tasks?taskId=${encodeURIComponent(item.taskId)}`} aria-label={`Open board task ${resolved.title}`}><StatusBadge tone={resolved.column === 'done' ? 'success' : 'neutral'} size="xs">{columns[resolved.column] ?? resolved.column}</StatusBadge></PluginLink>}
      {item.taskId && resolved === null && <StatusBadge tone="attention" size="xs">Board task missing</StatusBadge>}
      <ListRowActions reveal="always">
        {!item.taskId && <Button type="button" variant="ghost" size="icon-xs" disabled={busy} onClick={() => { void model.mutate(item, 'promote') }} aria-label={`Create board task for ${item.title}`}><Link2 aria-hidden="true" /></Button>}
        <Button type="button" variant="ghost" size="icon-xs" disabled={busy || (draft && draft.value !== draft.baseline)} onClick={() => { void model.mutate(item, 'remove') }} aria-label={`Remove ${item.title}`}><Trash2 aria-hidden="true" /></Button>
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
  resolvedTasks: Record<string, { column: string; title: string } | null>
  model: ChecklistModel
}) {
  const preference = `projects-hide-completed:${projectId}`
  const [hideCompleted, setHideCompleted] = useState(() => { try { return localStorage.getItem(preference) === 'true' } catch { return false } })
  const completed = tasks.filter(task => task.checked).length
  const visible = tasks.filter(task => !hideCompleted || !task.checked || model.descriptions[task.id])
  return <Stack gap="item">
    <div className="flex flex-wrap items-center justify-between gap-bakin-3">
      <h2>Tasks</h2>
      {completed > 0 && <Field orientation="horizontal" name="hide-completed"><Switch size="sm" checked={hideCompleted} onCheckedChange={(value: boolean) => { setHideCompleted(value); try { localStorage.setItem(preference, String(value)) } catch { /* private mode */ } }} /><FieldLabel>Hide completed ({completed})</FieldLabel></Field>}
    </div>
    <Text size="meta" tone="muted">{completed} of {tasks.length} tasks completed</Text>
    {tasks.length === 0 ? <SystemState kind="initial-empty" scope="inline" headingLevel={3} title="No tasks yet" />
      : visible.length === 0 ? <Text size="meta" tone="muted">All completed tasks are hidden.</Text>
      : <ListRows variant="separated" size="sm" aria-label="Project tasks">{visible.map(item => <TaskItem key={item.instanceId ?? item.id} item={item} resolved={item.taskId ? resolvedTasks[item.taskId] : undefined} model={model} />)}</ListRows>}
    {Object.entries(model.descriptions).filter(([, draft]) => draft.removed && draft.value !== draft.baseline).map(([id, draft]) => <Alert key={id} tone="attention"><AlertDescription>
      Details for “{draft.item.title}” remain unsaved because the item was removed.
      <Button type="button" size="sm" variant="outline" onClick={() => model.discardDescription(id)}>Discard removed item draft</Button>
    </AlertDescription></Alert>)}
    <Form aria-label="Add checklist task" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void model.add() }} busy={model.busy.add}>
      <InputGroup size="md" variant="outlined">
        <InputGroupInput value={model.newTitle} onChange={(event: React.ChangeEvent<HTMLInputElement>) => model.setNewTitle(event.target.value)} placeholder="Add task…" aria-label="Add task" />
        <InputGroupAddon align="inline-end"><InputGroupButton type="submit" size="icon-xs" disabled={model.busy.add || (!model.newTitle.trim() && !model.addIntent)} aria-label="Add task to checklist"><Plus aria-hidden="true" /></InputGroupButton></InputGroupAddon>
      </InputGroup>
      {model.addIntent && model.addIntent.raw !== model.newTitle && <Text size="meta">Confirming the earlier add for “{model.addIntent.title}” first. Your newer draft is kept.</Text>}
      <ErrorNotice message={model.errors.add} />
    </Form>
  </Stack>
}
