'use client'

import { useState } from 'react'
import { Plus, ExternalLink, Unlink, Trash2, Link2, ChevronRight } from 'lucide-react'
import { Button, Checkbox, Input, Textarea } from '@makinbakin/sdk/ui'
import { StatusBadge } from '@makinbakin/sdk/patterns'
import type { ProjectTask } from '../types'

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
    <div className="rounded-lg transition-colors hover:bg-bakin-surface-elevated">
      {/* Main row */}
      <div className="group flex items-start gap-2 px-1 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
          className="mt-0.5 shrink-0 text-bakin-text-muted hover:text-bakin-text-primary"
        >
          <ChevronRight className={`size-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </Button>

        <Checkbox
          checked={item.checked}
          onCheckedChange={(checked: boolean) => onToggle(checked === true)}
          aria-label={item.title}
          className="mt-0.5 shrink-0"
        />

        <span
          onClick={() => setExpanded(!expanded)}
          className={`flex-1 cursor-pointer text-bakin-typography-size-meta leading-snug ${item.checked ? 'line-through text-bakin-text-muted' : 'text-bakin-text-primary'}`}
        >
          {item.title}
        </span>

        {/* Linked task badge */}
        {item.taskId && resolved && (
          <StatusBadge
            tone={COLUMN_TONES[resolved.column] ?? 'neutral'}
            variant="soft"
            size="xs"
            icon={ExternalLink}
            className="font-mono"
          >
            {item.taskId.slice(0, 6)}
          </StatusBadge>
        )}

        {isStale && (
          <StatusBadge tone="danger" variant="soft" size="xs" icon={Unlink}>
            missing
          </StatusBadge>
        )}

        {/* Actions */}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {!item.taskId && !item.checked && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onPromote}
              aria-label="Create board task"
              title="Create board task"
              className="text-bakin-text-muted hover:text-bakin-text-primary"
            >
              <Link2 className="size-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onRemove}
            aria-label="Remove"
            title="Remove"
            className="text-bakin-text-muted hover:text-bakin-signal-danger"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="pb-2 pl-10 pr-1">
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
              variant="ghost"
              size="xs"
              onClick={() => { setDescDraft(item.description || ''); setEditingDesc(true) }}
              className="!h-auto w-full justify-start whitespace-normal p-0 text-left text-bakin-typography-size-meta font-bakin-typography-weight-regular text-bakin-text-muted hover:bg-transparent hover:text-bakin-text-primary"
            >
              {item.description || 'Add details...'}
            </Button>
          )}
        </div>
      )}
    </div>
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
    <div>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-bakin-text-muted">Tasks</h3>

      {tasks.length === 0 ? (
        <p className="mb-3 text-bakin-typography-size-meta text-bakin-text-muted">No tasks yet.</p>
      ) : (
        <div className="mb-3 space-y-0.5">
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
        </div>
      )}

      {/* Add new item */}
      <div className="flex gap-2">
        <Input
          type="text"
          value={newItemTitle}
          onChange={(e) => setNewItemTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Add task..."
          aria-label="Add task"
          className="flex-1 text-bakin-typography-size-meta"
        />
        <Button
          variant="outline"
          size="icon-sm"
          onClick={handleAdd}
          disabled={!newItemTitle.trim()}
          aria-label="Add task to checklist"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
