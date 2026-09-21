import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { ContentCalendar } from '../components/content-calendar'
import { BrainstormView } from '../components/brainstorm-view'
import { PlanWorkspace } from '../components/plan-workspace'
import type { Deliverable, Plan } from '../types'

class FixtureEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  close() {}
}
globalThis.EventSource = FixtureEventSource as unknown as typeof EventSource

export const collectionDeliverables: Deliverable[] = [
  { id: 'launch-copy', planId: 'launch', title: 'Spring menu launch with cross-team editorial review and publication approval', brief: 'Coordinate copy, photography, and channel-specific production.', channel: 'newsletter', contentType: 'blog', tone: 'warm', agent: 'basil', status: 'planned', taskId: 'task-launch', publishAt: '2026-01-15T16:00:00Z', prepStartAt: '2026-01-12T16:00:00Z', draft: {}, createdAt: '2026-01-10T10:00:00Z', updatedAt: '2026-01-14T10:00:00Z' },
  { id: 'weekend-copy', planId: 'launch', title: 'Weekend brunch photography and social copy', brief: 'Prepare the weekend package.', channel: 'instagram', contentType: 'blog', tone: 'calm', agent: 'pixel', status: 'in_review', taskId: 'task-weekend', publishAt: '2026-01-18T10:00:00Z', prepStartAt: '2026-01-15T10:00:00Z', draft: {}, createdAt: '2026-01-10T10:00:00Z', updatedAt: '2026-01-14T10:00:00Z' },
]
export const collectionPlan: Plan = {
  id: 'launch', title: 'Spring menu launch', brief: 'Coordinate a seasonal launch.', targetDate: '2026-01-15', agent: 'basil', status: 'in_prep',
  channels: collectionDeliverables.map(row => ({ id: row.channel, channel: row.channel, contentType: row.contentType, publishAt: row.publishAt, prepStartAt: row.prepStartAt })),
  createdAt: '2026-01-10T10:00:00Z', updatedAt: '2026-01-14T10:00:00Z',
}
export const collectionSessions = [
  { id: 'launch', title: 'Spring menu launch with cross-team editorial review and publication approval', agentId: 'basil', status: 'active', proposalCount: 3, approvedCount: 1, unread: true, streaming: false, createdAt: '2026-01-10T10:00:00Z', updatedAt: '2026-01-14T10:00:00Z' },
  { id: 'weekend', title: 'Weekend brunch guide', agentId: 'pixel', status: 'completed', proposalCount: 2, approvedCount: 2, unread: false, streaming: false, createdAt: '2026-01-10T10:00:00Z', updatedAt: '2026-01-14T10:00:00Z' },
]

function WorkspaceFixture() { return <PlanWorkspace planId="launch" /> }

export function mountCollectionFixture(surface: 'calendar' | 'brainstorm' | 'workspace') {
  const route = surface === 'workspace' ? '/messaging/plans/launch' : `/messaging/${surface}`
  const Page = surface === 'workspace' ? WorkspaceFixture : surface === 'calendar' ? ContentCalendar : BrainstormView
  createRoot(document.getElementById('root')!).render(
    <PluginUiFixtureHost
      fixture={{ ...DEFAULT_PLUGIN_UI_FIXTURE, route: route + (surface === 'calendar' ? '?view=list' : ''), randomSeed: `messaging-${surface}`, network: [
        { path: '/api/plugins/messaging/deliverables', status: 200, json: { deliverables: collectionDeliverables } },
        { path: '/api/plugins/messaging/plans/launch?id=launch', status: 200, json: { plan: collectionPlan, deliverables: collectionDeliverables } },
        { path: '/api/plugins/messaging/sessions', status: 200, json: { sessions: collectionSessions } },
        { path: '/api/plugin-settings/messaging', status: 200, json: { contentTypes: [{ id: 'blog', label: 'Blog post', prepLeadHours: 72 }] } },
      ] }}
      registrations={[{ id: 'messaging', routes: { [route]: Page } }]}
    />,
  )
}
