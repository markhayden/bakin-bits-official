/**
 * Projects plugin — client entry point.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { useRouter } from '@makinbakin/sdk/hooks'
import { Suspense, useEffect, type ReactNode } from 'react'
import { ProjectGrid } from './components/project-grid'
import { ProjectDetail } from './components/project-detail'

const navItems: NavItem[] = [
  { id: 'projects', label: 'Projects', icon: 'Compass', href: '/projects', order: 30 },
]

interface PluginRouteProps {
  params?: Record<string, string>
  id?: string
}

function ProjectsPageFrame({ children, edge = false }: { children: ReactNode; edge?: boolean }) {
  return (
    <div className={`${edge ? 'p-[5px]' : 'p-6'} flex flex-col h-full min-h-0 min-w-0 overflow-hidden`}>
      <Suspense>{children}</Suspense>
    </div>
  )
}

function ProjectsIndexRoute() {
  return (
    <ProjectsPageFrame edge>
      <ProjectGrid />
    </ProjectsPageFrame>
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
    <ProjectsPageFrame>
      <ProjectDetail
        projectId={projectId}
        onBack={() => router.push('/projects')}
        onEditChange={(editing: boolean) => {
          if (editing) router.replace(`/projects/${projectId}/edit`)
        }}
      />
    </ProjectsPageFrame>
  )
}

function ProjectEditRoute({ params, id }: PluginRouteProps) {
  const router = useRouter()
  const projectId = id ?? params?.id

  if (!projectId) return <ProjectsNewRoute />

  return (
    <ProjectsPageFrame>
      <ProjectDetail
        projectId={projectId}
        onBack={() => router.push('/projects')}
        initialEdit
        onEditChange={(editing: boolean) => {
          if (!editing) router.replace(`/projects/${projectId}`)
        }}
      />
    </ProjectsPageFrame>
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
})
