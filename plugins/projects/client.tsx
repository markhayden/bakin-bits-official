/**
 * Projects plugin — client entry point.
 *
 * Routes render bare components inside Suspense; each page composes the
 * SDK `Page` archetype itself (ProjectList and ProjectDetail own their
 * page canvas), so there is no local page frame.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { useRouter } from '@makinbakin/sdk/navigation'
import { Suspense, useEffect } from 'react'
import { ProjectList } from './components/project-list'
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
  pathname?: string
}

function ProjectsIndexRoute() {
  return (
    <Suspense>
      <ProjectList />
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

export function ProjectDetailRoute({ params, id, pathname }: PluginRouteProps) {
  const router = useRouter()
  const projectId = id ?? params?.id
  if (!projectId) return <ProjectsNewRoute />
  // Both declared paths share this component type. The host supplies the matched
  // pathname; key only by project so mode changes retain all mounted state.
  return <Suspense><ProjectDetail key={projectId} projectId={projectId}
    initialEdit={pathname === `/projects/${projectId}/edit`}
    onBack={() => router.push('/projects')}
    onEditChange={editing => router.replace(`/projects/${projectId}${editing ? '/edit' : ''}`)} />
  </Suspense>
}

registerPlugin({
  id: 'projects',
  navItems,
  routes: {
    '/projects': ProjectsIndexRoute,
    '/projects/new': ProjectsNewRoute,
    '/projects/[id]': ProjectDetailRoute,
    '/projects/[id]/edit': ProjectDetailRoute,
  },
  slots: {
    'nav-badge-providers': BrainstormBadgeProvider,
  },
})
