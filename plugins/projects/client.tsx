/**
 * Projects plugin — client entry point.
 *
 * Routes render bare components inside Suspense; each page composes the
 * SDK `Page` archetype itself (ProjectGrid and ProjectDetail own their
 * page canvas), so there is no local page frame.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { useRouter } from '@makinbakin/sdk/navigation'
import { Suspense, useEffect } from 'react'
import { ProjectGrid } from './components/project-grid'
import { ProjectDetail } from './components/project-detail'
import { BrainstormBadgeProvider } from './components/brainstorm-badge-provider'

const navItems: NavItem[] = [
  {
    id: 'projects',
    label: 'Projects',
    icon: 'FolderKanban',
    href: '/projects',
    order: 10,
    section: 'plan-and-automate',
  },
]

interface PluginRouteProps {
  params?: Record<string, string>
  id?: string
}

function ProjectsIndexRoute() {
  return (
    <Suspense>
      <ProjectGrid />
    </Suspense>
  )
}

function ProjectsNewRoute() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/projects')
  }, [router])

  return null
}

function ProjectDetailRoute({ params, id }: PluginRouteProps) {
  const router = useRouter()
  const projectId = id ?? params?.id

  if (!projectId) return <ProjectsNewRoute />

  return (
    <Suspense>
      <ProjectDetail
        projectId={projectId}
        onBack={() => router.push('/projects')}
        onEditChange={(editing: boolean) => {
          if (editing) router.replace(`/projects/${projectId}/edit`)
        }}
      />
    </Suspense>
  )
}

function ProjectEditRoute({ params, id }: PluginRouteProps) {
  const router = useRouter()
  const projectId = id ?? params?.id

  if (!projectId) return <ProjectsNewRoute />

  return (
    <Suspense>
      <ProjectDetail
        projectId={projectId}
        onBack={() => router.push('/projects')}
        initialEdit
        onEditChange={(editing: boolean) => {
          if (!editing) router.replace(`/projects/${projectId}`)
        }}
      />
    </Suspense>
  )
}

registerPlugin({
  id: 'projects',
  navItems,
  routes: {
    '/projects': ProjectsIndexRoute,
    '/projects/new': ProjectsNewRoute,
    '/projects/[id]': ProjectDetailRoute,
    '/projects/[id]/edit': ProjectEditRoute,
  },
  slots: {
    'nav-badge-providers': BrainstormBadgeProvider,
  },
})
