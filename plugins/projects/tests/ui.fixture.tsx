import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { ProjectList } from '../components/project-list'
import type { ProjectSummary } from '../types'

// Scope the fixture to the real index page. Deterministic data exercises the
// row pattern's wrapping, status and every resume signal at both widths; the
// archived project stays out of "All".
const projects: ProjectSummary[] = [
  { id: 'launch', title: 'Spring menu launch with cross-team editorial review and publication approval', status: 'active', owner: 'Jessica', progress: 40, taskCount: 5, doneCount: 2, assetCount: 2, updated: '2026-01-15T10:00:00Z', brainstormStreaming: true },
  { id: 'redesign', title: 'Food blog redesign', status: 'draft', owner: 'Pixel', progress: 0, taskCount: 3, doneCount: 0, assetCount: 0, updated: '2026-01-14T10:00:00Z', waitingForYou: true },
  { id: 'menu', title: 'Holiday menu', status: 'active', owner: 'Pixel', progress: 25, taskCount: 4, doneCount: 1, assetCount: 0, updated: '2026-01-13T10:00:00Z', planUpdated: true },
  { id: 'archive', title: 'Recipe archive migration', status: 'completed', owner: 'Rolo', progress: 100, taskCount: 4, doneCount: 4, assetCount: 0, updated: '2026-01-12T10:00:00Z' },
  { id: 'old', title: 'Previous seasonal menu', status: 'archived', owner: 'Jessica', progress: 100, taskCount: 2, assetCount: 1, updated: '2025-12-12T10:00:00Z' },
]

const fixture = {
  ...DEFAULT_PLUGIN_UI_FIXTURE,
  route: '/projects',
  randomSeed: 'official-projects-list',
  network: [
    { path: '/api/plugins/projects/', status: 200, json: { projects } },
    ...projects.map(project => ({ method: 'DELETE', path: `/api/plugins/projects/${project.id}`, status: 200, json: { ok: true } })),
    ...['draft', 'active', 'completed', 'archived'].map(status => ({
      path: `/api/plugins/projects/?status=${status}`,
      status: 200,
      json: { projects: projects.filter(project => project.status === status) },
    })),
  ],
} as const

const registrations = [{ id: 'projects', routes: { '/projects': ProjectList } }]

createRoot(document.getElementById('root')!).render(
  <PluginUiFixtureHost fixture={fixture} registrations={registrations} />,
)
