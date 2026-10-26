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
import { useAgentList, useDebug, usePluginEvent } from "@makinbakin/sdk/hooks"
import { OPERATOR_DECLARATION_HEADERS } from '@makinbakin/sdk/utils'
import { ProjectRow } from './project-row'
import { StartScreen } from './start-screen'
import type { ProjectSummary, ProjectStatus } from '../types'

interface ScoreInfo {
  score: number
  indexScores?: Record<string, number>
}

// "All" leaves archived projects out; they have their own filter (D18).
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [startScreen, setStartScreen] = useState(false)
  const agentList = useAgentList()
  const agentNames = useMemo(() => new Map(agentList.map(agent => [agent.id, agent.name ?? agent.id])), [agentList])
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
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`Could not load projects (HTTP ${res.status})`)
      const data = await res.json()
      if (!Array.isArray(data.projects)) throw new Error('The project list response was invalid. Please retry.')
      if (requestVersion === listRequestVersion.current) {
        setProjects(status === 'all' ? data.projects.filter((project: ProjectSummary) => project.status !== 'archived') : data.projects)
        if (status === 'all' && data.projects.length === 0) setStartScreen(true)
        setLoadError(null)
      }
    } catch (err) {
      if (requestVersion === listRequestVersion.current) {
        setLoadError(err instanceof Error ? err.message : 'Could not load projects. Please retry.')
      }
    } finally {
      if (requestVersion === listRequestVersion.current) setLoading(false)
    }
  }, [status])

  useEffect(() => {
    setLoading(true)
    void fetchProjects()
    return () => { listRequestVersion.current += 1 }
  }, [fetchProjects])

  // Keep the per-row unread/working indicators live: settles and seen
  // writes refresh; the first chunk of a NEW turn refreshes once so the
  // working dot appears (later chunks for an already-marked project skip).
  usePluginEvent('projects.brainstorm.done', () => { void fetchProjects() })
  usePluginEvent('projects.brainstorm.error', () => { void fetchProjects() })
  usePluginEvent('projects.brainstorm.seen', () => { void fetchProjects() })
  // Plan revisions and board-driven step changes move the resume signal.
  usePluginEvent('projects.changed', () => { void fetchProjects() })
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

  const handleNew = () => router.push('/projects/new')

  const handleDeleteProject = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/plugins/projects/${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...OPERATOR_DECLARATION_HEADERS },
        body: JSON.stringify({ deleteLinkedTasks: false }),
      })
      if (!res.ok) throw new Error(`Could not delete project (${res.status}). Please try again.`)
      // An earlier brainstorm-triggered refresh must not restore the deleted row.
      listRequestVersion.current += 1
      setLoading(false)
      setProjects(current => current.filter(project => project.id !== deleteTarget.id))
      // The unfiltered list decides whether that was the last project.
      if (status === 'all') void fetchProjects()
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete project. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  // No projects at all: the list IS the start screen (D18). It latches from a
  // completed unfiltered empty response and stays until navigation — the
  // create's own projects.changed refresh must not unmount the composer while
  // its request is still in flight.
  if (startScreen) return <StartScreen />

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Organize related work, track progress, and keep project context, assets, and tasks together."
        meta={loading || loadError ? undefined : (
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
            New project
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
        ) : loadError ? (
          <SystemState
            kind="error"
            scope="section"
            title="Could not load projects"
            description={loadError}
            action={<Button variant="outline" onClick={() => { setLoading(true); void fetchProjects() }}>Retry</Button>}
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
              title={status === 'all' ? 'Nothing in progress' : `No ${status} projects`}
              description={status === 'all' ? 'Only archived projects remain. Start something new, or look under Archived.' : 'Projects with this status will appear here.'}
              action={status === 'all' ? (
                <Button onClick={handleNew}>
                  <Plus className="size-bakin-4" />
                  New project
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
                  leadName={agentNames.get(p.owner) ?? (p.owner || 'The lead')}
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

    </Page>
  )
}
