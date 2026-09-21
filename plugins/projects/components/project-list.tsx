'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import { Badge, Button, Skeleton, SystemState } from "@makinbakin/sdk/ui"
import { Stack } from "@makinbakin/sdk/layout"
import {
  ListRow,
  ListRows,
  ConfirmDialog,
  Page,
  PageBody,
  PageControls,
  PageHeader,
  ScoreOverlay,
  SearchInput,
  SegmentedControl,
} from "@makinbakin/sdk/patterns"
import { useQueryState, useRouter } from "@makinbakin/sdk/navigation"
import { useSearch } from "@makinbakin/sdk/hooks"
import { useDebug, usePluginEvent } from "@makinbakin/sdk/hooks"
import { ProjectRow } from './project-row'
import { NewProjectDialog } from './new-project-dialog'
import type { ProjectSummary, ProjectStatus } from '../types'

interface ScoreInfo {
  score: number
  indexScores?: Record<string, number>
}

const STATUS_TABS: { label: string; value: ProjectStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
  { label: 'Archived', value: 'archived' },
]

export function ProjectList() {
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const newProjectButtonRef = useRef<HTMLButtonElement>(null)
  const listRequestVersion = useRef(0)

  const [status, setStatus] = useQueryState('status', 'all')
  const [search, setSearch] = useQueryState('q', '')
  const [debug] = useDebug()

  const fetchProjects = useCallback(async () => {
    const requestVersion = ++listRequestVersion.current
    try {
      const url = status === 'all'
        ? '/api/plugins/projects/'
        : `/api/plugins/projects/?status=${status}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        if (requestVersion === listRequestVersion.current) setProjects(data.projects)
      }
    } finally {
      if (requestVersion === listRequestVersion.current) setLoading(false)
    }
  }, [status])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // Keep the per-row unread/working indicators live: settles and seen
  // writes refresh; the first chunk of a NEW turn refreshes once so the
  // working dot appears (later chunks for an already-marked project skip).
  usePluginEvent('projects.brainstorm.done', () => { void fetchProjects() })
  usePluginEvent('projects.brainstorm.error', () => { void fetchProjects() })
  usePluginEvent('projects.brainstorm.seen', () => { void fetchProjects() })
  usePluginEvent('projects.brainstorm.chunk', (payload) => {
    const id = String(payload.projectId ?? '')
    if (id && !projects.some(p => p.id === id && p.brainstormStreaming)) void fetchProjects()
  })

  const searchHook = useSearch({ plugin: 'projects', facets: ['status'], debounce: 300 })
  useEffect(() => {
    if (search) searchHook.search(search)
    else searchHook.clear()
    // searchHook is a fresh object each render; only the query string change
    // should re-run this effect.
  }, [search])

  // Build a score map keyed by project id. Projects index with the raw
  // project.id (no search key prefix — see plugins/projects/index.ts reindex), so
  // no prefix-strip is needed. Used for both the relevance reorder AND the
  // debug-mode relevance overlay.
  const scoreMap = useMemo(() => {
    const map = new Map<string, ScoreInfo>()
    for (const r of searchHook.results) {
      map.set(r.id, { score: r.score, indexScores: r.indexScores })
    }
    return map
  }, [searchHook.results])

  const filtered = useMemo(() => {
    if (!search.trim()) return projects
    if (searchHook.results.length) {
      return projects
        .filter(p => scoreMap.has(p.id))
        .sort((a, b) => (scoreMap.get(b.id)?.score ?? 0) - (scoreMap.get(a.id)?.score ?? 0))
    }
    const q = search.toLowerCase()
    return projects.filter(p => p.title.toLowerCase().includes(q))
  }, [projects, search, searchHook.results, scoreMap])

  const handleNew = () => {
    setCreateError(null)
    setNewProjectOpen(true)
  }

  const handleDeleteProject = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/plugins/projects/${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteLinkedTasks: false }),
      })
      if (!res.ok) throw new Error(`Could not delete project (${res.status}). Please try again.`)
      // An earlier brainstorm-triggered refresh must not restore the deleted row.
      listRequestVersion.current += 1
      setProjects(current => current.filter(project => project.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete project. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  const handleCreateProject = async (title: string) => {
    setCreatingProject(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/plugins/projects/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `Failed to create project (${res.status})`)
      }
      const data = await res.json()
      if (typeof data.id !== 'string' || !data.id) {
        throw new Error('Project create response did not include an id')
      }
      setNewProjectOpen(false)
      router.push(`/projects/${data.id}/edit`)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingProject(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Organize related work, track progress, and keep project context, assets, and tasks together."
        meta={loading ? undefined : (
          <Badge size="xs" tone="neutral" variant="soft">{filtered.length} shown</Badge>
        )}
        controls={(
          <SearchInput
            align="end"
            label="Search projects"
            value={search}
            onValueChange={setSearch}
            placeholder="Search projects…"
            mobileFullWidth
            className="@3xl/page-header:w-[22rem] @3xl/page-header:shrink-0"
          />
        )}
        actions={(
          <Button ref={newProjectButtonRef} onClick={handleNew}>
            <Plus className="size-bakin-4" />
            New Project
          </Button>
        )}
      />

      {/* Status filter */}
      <PageControls variant="filters" label="Project filters">
        <SegmentedControl
          ariaLabel="Filter by status"
          options={STATUS_TABS}
          value={status}
          onValueChange={setStatus}
        />
      </PageControls>

      {/* Standard separated rows */}
      <PageBody label="Projects">
        {loading ? (
          <SystemState
            kind="loading"
            scope="section"
            title="Loading projects"
            preview={(
              <ListRows variant="separated" aria-label="Loading projects">
                {Array.from({ length: 6 }).map((_, i) => (
                  <ListRow key={i}>
                    <Stack gap="dense">
                      <Skeleton className="h-bakin-4 w-1/3" />
                      <Skeleton className="h-bakin-4 w-2/3" />
                    </Stack>
                  </ListRow>
                ))}
              </ListRows>
            )}
          />
        ) : filtered.length === 0 ? (
          search ? (
            <SystemState
              kind="no-results"
              scope="section"
              title="No matching projects"
              description="Try another search or clear the current query."
              action={<Button variant="outline" onClick={() => setSearch('')}>Clear search</Button>}
            />
          ) : (
            <SystemState
              kind="initial-empty"
              scope="section"
              title={status === 'all' ? 'No projects yet' : `No ${status} projects`}
              description={status === 'all' ? 'Create one to get started.' : 'Projects with this status will appear here.'}
              action={status === 'all' ? (
                <Button onClick={handleNew}>
                  <Plus className="size-bakin-4" />
                  New Project
                </Button>
              ) : undefined}
            />
          )
        ) : (
          <ListRows variant="separated" aria-label="Projects">
            {filtered.map((p) => {
              const scoreInfo = scoreMap.get(p.id)
              const showScores = debug && scoreInfo && search.trim()
              return (
                <ProjectRow
                  key={p.id}
                  project={p}
                  onClick={() => router.push(`/projects/${p.id}`)}
                  onDelete={(trigger) => {
                    deleteTriggerRef.current = trigger
                    setDeleteError(null)
                    setDeleteTarget(p)
                  }}
                  scoreOverlay={showScores && scoreInfo ? (
                    <ScoreOverlay info={scoreInfo} className="pointer-events-auto absolute left-bakin-1 top-bakin-1 z-10" />
                  ) : undefined}
                />
              )
            })}
          </ListRows>
        )}
      </PageBody>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete project?"
        description={`This will permanently delete “${deleteTarget?.title || 'Untitled project'}” and all its checklist items. Any running brainstorm will be stopped. Linked board tasks and assets will be kept.`}
        confirmLabel="Delete project"
        busyLabel="Deleting…"
        confirmTone="danger"
        busy={deleting}
        error={deleteError}
        finalFocus={() => deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : newProjectButtonRef.current}
        onConfirm={() => { void handleDeleteProject() }}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null)
        }}
      />

      <NewProjectDialog
        open={newProjectOpen}
        creating={creatingProject}
        error={createError}
        onConfirm={handleCreateProject}
        onCancel={() => {
          if (!creatingProject) setNewProjectOpen(false)
        }}
      />
    </Page>
  )
}
