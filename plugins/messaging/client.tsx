/**
 * Messaging plugin — client entry point.
 */
import { registerPlugin } from '@makinbakin/sdk'
import type { NavItem } from '@makinbakin/sdk'
import { useRouter } from '@makinbakin/sdk/hooks'
import { Suspense, useEffect, type ReactNode } from 'react'
import { ContentCalendar } from './components/content-calendar'
import { BrainstormView } from './components/brainstorm-view'

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
      { id: 'messaging-brainstorm', label: 'Brainstorm', icon: 'Sparkles', href: '/messaging/brainstorm' },
    ],
  },
]

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
    '/messaging/brainstorm': MessagingBrainstormRoute,
  },
})
