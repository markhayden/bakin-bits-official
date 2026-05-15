/**
 * Messaging plugin — client entry point.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { useRouter } from '@makinbakin/sdk/hooks'
import { Suspense, useEffect, type ReactNode } from 'react'
import { ContentCalendar } from './components/content-calendar'
import { BrainstormView } from './components/brainstorm-view'
import { PlanList } from './components/plan-list'
import { PlanWorkspace } from './components/plan-workspace'

const navItems: NavItem[] = [
  {
    id: 'messaging',
    label: 'Messaging',
    icon: 'MessageSquare',
    href: '/messaging',
    order: 25,
    alwaysExpanded: true,
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

function MessagingPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="p-6 flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
      <Suspense>{children}</Suspense>
    </div>
  )
}

function MessagingCalendarRoute() {
  return (
    <MessagingPageFrame>
      <ContentCalendar />
    </MessagingPageFrame>
  )
}

function MessagingPlansRoute() {
  const router = useRouter()

  return (
    <MessagingPageFrame>
      <PlanList onSelectPlan={(plan) => router.push(`/messaging/plans/${plan.id}`)} />
    </MessagingPageFrame>
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
    <MessagingPageFrame>
      <PlanWorkspace
        planId={planId}
        onBack={() => router.push('/messaging/plans')}
        onDeleted={() => router.push('/messaging/plans')}
      />
    </MessagingPageFrame>
  )
}

function MessagingBrainstormRoute() {
  return (
    <MessagingPageFrame>
      <BrainstormView />
    </MessagingPageFrame>
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
})
