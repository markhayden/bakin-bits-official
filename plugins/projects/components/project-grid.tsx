'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { Badge, Button, Skeleton, SystemState } from "@makinbakin/sdk/ui"
import {
  Page,
  PageBody,
  PageControls,
  PageHeader,
  SearchInput,
  SegmentedControl,
} from "@makinbakin/sdk/patterns"
import { useQueryState, useRouter } from "@makinbakin/sdk/navigation"
import { useSearch } from "@makinbakin/sdk/hooks"
import { useDebug } from "@makinbakin/sdk/hooks"
import { ProjectCard } from './project-card'
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

export function ProjectGrid() {
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [status, setStatus] = useQueryState('status', 'all')
  const [search, setSearch] = useQueryState('q', '')
  const [debug] = useDebug()

  const fetchProjects = useCallback(async () => {
    try {
      const url = status === 'all'
        ? '/api/plugins/projects/'
        : `/api/plugins/projects/?status=${status}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setProjects(data.projects)
      }
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

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
  // debug-mode RRF/BM25/SEM overlay.
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
          <Badge size="xs" tone="neutral" variant="outline">{filtered.length} shown</Badge>
        )}
        controls={(
          <SearchInput
            align="end"
            label="Search projects"
            value={search}
            onValueChange={setSearch}
            placeholder="Search projects…"
            mobileFullWidth
          />
        )}
        actions={(
          <Button onClick={handleNew}>
            <Plus className="size-4" />
            New Project
          </Button>
        )}
      />

      {/* Status filter */}
      <PageControls label="Project filters">
        <SegmentedControl
          ariaLabel="Filter by status"
          options={STATUS_TABS}
          value={status}
          onValueChange={setStatus}
        />
      </PageControls>

      {/* Grid */}
      <PageBody label="Projects">
        {loading ? (
          <div className="grid grid-cols-1 gap-bakin-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
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
                  <Plus className="size-4" />
                  New Project
                </Button>
              ) : undefined}
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-bakin-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => {
              const scoreInfo = scoreMap.get(p.id)
              const showScores = debug && scoreInfo && search.trim()
              const semKey = 'embeddings'
              const bm25Key = scoreInfo?.indexScores
                ? Object.keys(scoreInfo.indexScores).find(k => k !== semKey)
                : undefined
              return (
                <div key={p.id} className="relative">
                  <ProjectCard
                    project={p}
                    onClick={() => router.push(`/projects/${p.id}`)}
                  />
                  {showScores && scoreInfo && (
                    <div className="absolute top-1.5 left-1.5 flex flex-col gap-0.5 font-mono text-[10px] bg-black/80 px-1.5 py-1 rounded pointer-events-none">
                      <span className="text-amber-400">RRF {scoreInfo.score.toFixed(3)}</span>
                      <span className="text-cyan-400">
                        BM25 {(bm25Key ? scoreInfo.indexScores?.[bm25Key] ?? 0 : 0).toFixed(3)}
                      </span>
                      <span className="text-purple-400">
                        SEM {(scoreInfo.indexScores?.[semKey] ?? 0).toFixed(3)}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </PageBody>

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
