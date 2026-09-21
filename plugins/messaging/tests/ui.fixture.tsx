import '@makinbakin/sdk/styles.css'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { useRouter } from '@makinbakin/sdk/navigation'
import { PlanList } from '../components/plan-list'
import type { Plan } from '../types'

// The live hook owns a native SSE connection, outside the SDK fetch fixture.
// Keep that stream inert here; live SSE refresh is outside this layout fixture.
class FixtureEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  close() {}
}
globalThis.EventSource = FixtureEventSource as unknown as typeof EventSource

const base: Plan = {
  id: 'launch', title: 'Spring menu launch with cross-team editorial review and publication approval',
  brief: 'Coordinate copy, photography, and channel-specific production before the seasonal launch.',
  targetDate: '2026-01-15', agent: 'basil', status: 'needs_review',
  campaign: 'Seasonal menu', sourceSessionId: 'brainstorm-launch',
  channels: [{ id: 'newsletter', channel: 'newsletter', contentType: 'blog', publishAt: '2026-01-15T16:00:00Z', prepStartAt: '2026-01-12T16:00:00Z' }],
  createdAt: '2026-01-10T10:00:00Z', updatedAt: '2026-01-14T10:00:00Z',
}

// Real Plans index only; calendar, workspace and brainstorm stay separate.
const plans: Plan[] = [
  base,
  { ...base, id: 'soup', title: 'Soup week photography and newsletter', status: 'in_prep', campaign: 'Winter favorites', sourceSessionId: undefined },
  { ...base, id: 'weekend', title: 'Weekend brunch guide', targetDate: '2026-01-18', agent: 'pixel', status: 'done', channels: [], sourceSessionId: undefined },
]

function PlansFixture() {
  const router = useRouter()
  return <PlanList onSelectPlan={plan => router.push(`/messaging/plans/${plan.id}`)} onStartBrainstorm={() => router.push('/messaging/brainstorm')} />
}

createRoot(document.getElementById('root')!).render(
  <PluginUiFixtureHost
    fixture={{
      ...DEFAULT_PLUGIN_UI_FIXTURE,
      route: '/messaging/plans',
      randomSeed: 'official-messaging-plans',
      network: [{ path: '/api/plugins/messaging/plans', status: 200, json: { plans } }],
    }}
    registrations={[{ id: 'messaging', routes: { '/messaging/plans': PlansFixture } }]}
  />,
)
