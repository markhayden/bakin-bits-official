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
import { Suspense } from 'react'
import { ProjectList } from './components/project-list'
import { ProjectDetail } from './components/project-detail'
import { BrainstormBadgeProvider } from './components/brainstorm-badge-provider'
import { StartScreen } from './components/start-screen'

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
      <ProjectList />
    </Suspense>
  )
}

function ProjectsNewRoute() {
  const router = useRouter()
  return (
    <Suspense>
      <StartScreen onBack={() => router.push('/projects')} />
    </Suspense>
  )
}

export function ProjectDetailRoute({ params, id }: PluginRouteProps) {
  const router = useRouter()
  const projectId = id ?? params?.id
  if (!projectId) return <ProjectsNewRoute />
  return <Suspense><ProjectDetail key={projectId} projectId={projectId} onBack={() => router.push('/projects')} /></Suspense>
}

registerPlugin({
  id: 'projects',
  navItems,
  routes: {
    '/projects': ProjectsIndexRoute,
    '/projects/new': ProjectsNewRoute,
    '/projects/[id]': ProjectDetailRoute,
  },
  slots: {
    'nav-badge-providers': BrainstormBadgeProvider,
  },
})
