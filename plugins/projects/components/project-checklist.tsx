'use client'

import { useState } from 'react'
import { Plus, ExternalLink, Unlink, Trash2, Link2, ChevronRight } from 'lucide-react'
import {
  Button,
  Checkbox,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  SystemState,
  Text,
  Textarea,
} from '@makinbakin/sdk/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { ListRow, ListRowActions, ListRows, StatusBadge } from '@makinbakin/sdk/patterns'
import type { ProjectTask } from '../types'
import { cn } from '@makinbakin/sdk/utils'

type StatusTone = 'neutral' | 'success' | 'attention' | 'danger' | 'accent'

const COLUMN_TONES: Record<string, StatusTone> = {
  backlog: 'neutral',
  todo: 'neutral',
  inProgress: 'accent',
  review: 'attention',
  done: 'success',
  archived: 'neutral',
  blocked: 'danger',
}

interface ResolvedTasks {
  [taskId: string]: { column: string; title: string } | null
}

interface ChecklistProps {
  projectId: string
  tasks: ProjectTask[]
  resolvedTasks: ResolvedTasks
  onToggle: (taskItemId: string, checked: boolean) => void
  onAdd: (title: string) => void
  onRemove: (taskItemId: string) => void
  onPromote: (taskItemId: string) => void
}

function TaskItem({
  item,
  resolved,
  isStale,
  onToggle,
  onRemove,
  onPromote,
  onUpdate,
}: {
  item: ProjectTask
  resolved: { column: string; title: string } | null
  isStale: boolean
  onToggle: (checked: boolean) => void
  onRemove: () => void
  onPromote: () => void
  onUpdate: (updates: { title?: string; description?: string }) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(item.description || '')

  const saveDesc = () => {
    onUpdate({ description: descDraft.trim() })
    setEditingDesc(false)
  }

  return (
    <ListRow>
      {/* Main row */}
      <div className="flex items-start gap-bakin-2">
        <Checkbox
          checked={item.checked}
          onCheckedChange={(checked: boolean) => onToggle(checked === true)}
          aria-label={item.title}
          className="mt-0.5 shrink-0"
        />

        {/* The title is the real expand/collapse control: keyboard, pointer,
            and screen readers all reach the same button. */}
        <Button
          type="button"
          variant="ghost"
          size="inline"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="min-w-0 flex-1"
        >
          <ChevronRight aria-hidden="true" className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} />
          <Text size="meta" tone={item.checked ? 'muted' : 'default'} className={cn('min-w-0 leading-snug', item.checked && 'line-through')}>
            {item.title}
          </Text>
        </Button>

        {/* Linked task badge */}
        {item.taskId && resolved && (
          <StatusBadge
            tone={COLUMN_TONES[resolved.column] ?? 'neutral'}
            variant="soft"
            size="xs"
            icon={ExternalLink}
          >
            {item.taskId.slice(0, 6)}
          </StatusBadge>
        )}

        {isStale && (
          <StatusBadge tone="danger" variant="soft" size="xs" icon={Unlink}>
            missing
          </StatusBadge>
        )}

        {/* Actions — revealed on row hover AND keyboard focus-within */}
        <ListRowActions reveal="hover">
          {!item.taskId && !item.checked && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onPromote}
              aria-label="Create board task"
            >
              <Link2 aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onRemove}
            aria-label="Remove"
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </ListRowActions>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="pb-bakin-2 pl-10 pr-bakin-1">
          {editingDesc ? (
            <div className="space-y-1.5">
              <Textarea
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Add details..."
                rows={2}
                className="w-full resize-y text-bakin-typography-size-meta leading-relaxed"
                autoFocus
              />
              <div className="flex gap-1.5">
                <Button variant="secondary" size="xs" onClick={saveDesc}>
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => { setDescDraft(item.description || ''); setEditingDesc(false) }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="inline"
              onClick={() => { setDescDraft(item.description || ''); setEditingDesc(true) }}
              className="w-full"
            >
              <Text size="meta" tone="muted" className="min-w-0 leading-relaxed">
                {item.description || 'Add details...'}
              </Text>
            </Button>
          )}
        </div>
      )}
    </ListRow>
  )
}

export function ProjectChecklist({
  projectId,
  tasks,
  resolvedTasks,
  onToggle,
  onAdd,
  onRemove,
  onPromote,
}: ChecklistProps) {
  const [newItemTitle, setNewItemTitle] = useState('')

  const handleAdd = () => {
    if (!newItemTitle.trim()) return
    onAdd(newItemTitle.trim())
    setNewItemTitle('')
  }

  const handleUpdate = async (taskItemId: string, updates: { title?: string; description?: string }) => {
    await fetch(`/api/plugins/projects/${projectId}/checklist/${taskItemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    // Parent will refetch via SSE or next interaction
  }

  return (
    <Stack gap="item">
      <h3>Tasks</h3>

      {tasks.length === 0 ? (
        <SystemState kind="initial-empty" scope="inline" headingLevel={4} title="No tasks yet." />
      ) : (
        <ListRows variant="separated" size="sm" aria-label="Project tasks">
          {tasks.map((item) => {
            const resolved = item.taskId ? resolvedTasks[item.taskId] : null
            const stale = !!(item.taskId && resolvedTasks[item.taskId] === null)

            return (
              <TaskItem
                key={item.id}
                item={item}
                resolved={resolved}
                isStale={stale}
                onToggle={(checked) => onToggle(item.id, checked)}
                onRemove={() => onRemove(item.id)}
                onPromote={() => onPromote(item.id)}
                onUpdate={(updates) => handleUpdate(item.id, updates)}
              />
            )
          })}
        </ListRows>
      )}

      {/* Add new item */}
      <InputGroup>
        <InputGroupInput
          type="text"
          value={newItemTitle}
          onChange={(e) => setNewItemTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Add task..."
          aria-label="Add task"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            onClick={handleAdd}
            disabled={!newItemTitle.trim()}
            aria-label="Add task to checklist"
          >
            <Plus aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Stack>
  )
}
