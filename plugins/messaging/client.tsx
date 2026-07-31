/**
 * Messaging plugin — client entry point.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { useRouter } from '@makinbakin/sdk/navigation'
import { Suspense, useEffect } from 'react'
import { ContentCalendar } from './components/content-calendar'
import { BrainstormView } from './components/brainstorm-view'
import { PlanList } from './components/plan-list'
import { PlanWorkspace } from './components/plan-workspace'
import { PlansBadgeProvider } from './components/plans-badge-provider'

const navItems: NavItem[] = [
  {
    id: 'messaging',
    label: 'Messaging',
    icon: 'MessageSquare',
    href: '/messaging',
    order: 25,
    children: [
      { id: 'messaging-calendar', label: 'Calendar', icon: 'CalendarDays', href: '/messaging/calendar' },
      { id: 'messaging-plans', label: 'Plans', icon: 'ClipboardList', href: '/messaging/plans' },
      { id: 'messaging-brainstorm', label: 'Brainstorm', icon: 'Sparkles', href: '/messaging/brainstorm' },
    ],
  },
]

interface PluginRouteProps {
  params?: Record<string, string>
  id?: string
}

function MessagingIndexRoute() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/messaging/calendar')
  }, [router])

  return null
}

function MessagingCalendarRoute() {
  return (
    <Suspense>
      <ContentCalendar />
    </Suspense>
  )
}

function MessagingPlansRoute() {
  const router = useRouter()

  return (
    <Suspense>
      <PlanList
        onSelectPlan={(plan) => router.push(`/messaging/plans/${plan.id}`)}
        onStartBrainstorm={() => router.push('/messaging/brainstorm')}
      />
    </Suspense>
  )
}

function MessagingPlansRedirectRoute() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/messaging/plans')
  }, [router])

  return null
}

function MessagingPlanWorkspaceRoute({ params, id }: PluginRouteProps) {
  const router = useRouter()
  const planId = id ?? params?.id

  if (!planId) return <MessagingPlansRedirectRoute />

  return (
    <Suspense>
      <PlanWorkspace
        planId={planId}
        onBack={() => router.push('/messaging/plans')}
        onDeleted={() => router.push('/messaging/plans')}
      />
    </Suspense>
  )
}

function MessagingBrainstormRoute() {
  return (
    <Suspense>
      <BrainstormView />
    </Suspense>
  )
}

registerPlugin({
  id: 'messaging',
  navItems,
  routes: {
    '/messaging': MessagingIndexRoute,
    '/messaging/calendar': MessagingCalendarRoute,
    '/messaging/plans': MessagingPlansRoute,
    '/messaging/plans/[id]': MessagingPlanWorkspaceRoute,
    '/messaging/brainstorm': MessagingBrainstormRoute,
  },
  // Background runner that keeps the Plans nav badge in sync with the
  // needs_review count. Stays mounted while the plugin is registered.
  slots: {
    'nav-badge-providers': PlansBadgeProvider,
  },
})
