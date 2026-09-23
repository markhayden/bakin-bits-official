import '@makinbakin/sdk/styles.css'
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { Stack } from '@makinbakin/sdk/layout'
import { RenderedPlan } from '../components/rendered-plan'
import { assertPlanSpacing } from './plan-layout-check'

const previous = '# Weekend plan\n\n## Goal\n\nPlan a short walk.\n\n## Route\n\n- River trail\n- Visitor center'
const current = previous.replace('Plan a short walk.', 'Plan a short walk and photograph the river.')

function PlanFixture() {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = root.current!
    let cancelled = false
    let started = false
    const check = () => {
      if (started || !element.querySelector('[data-plan-changed-block]')) return
      started = true
      observer.disconnect()
      void document.fonts.ready.then(() => {
        requestAnimationFrame(() => {
          if (cancelled) return
          try {
            assertPlanSpacing(element)
            element.dataset.planLayoutChecked = 'passed'
          } catch (error) {
            // The canonical harness treats console errors as failed checks.
            // Mark completion too so it reports both viewport failures.
            console.error(error instanceof Error ? error.message : String(error))
            element.dataset.planLayoutChecked = 'failed'
          }
        })
      })
    }
    const observer = new MutationObserver(check)
    observer.observe(element, { childList: true, subtree: true })
    check()
    return () => { cancelled = true; observer.disconnect() }
  }, [])

  return <div ref={root}><Stack gap="section">
    <section aria-label="Latest changes"><RenderedPlan projectId="changed" body={current} /></section>
    <section aria-label="Changes hidden"><RenderedPlan projectId="hidden" body={current} hintsEnabled={false} /></section>
    <section aria-label="No history"><RenderedPlan projectId="new" body={current} /></section>
  </Stack></div>
}

createRoot(document.getElementById('root')!).render(
  <PluginUiFixtureHost
    fixture={{ ...DEFAULT_PLUGIN_UI_FIXTURE, route: '/projects/plan-fixture', network: [
      { path: '/api/plugins/projects/changed/history', status: 200, json: { history: [{ ts: '2026-01-14T10:00:00Z', author: 'agent', body: previous }] } },
      { path: '/api/plugins/projects/hidden/history', status: 200, json: { history: [] } },
      { path: '/api/plugins/projects/new/history', status: 200, json: { history: [] } },
    ] }}
    registrations={[{ id: 'projects', routes: { '/projects/plan-fixture': PlanFixture } }]}
  />,
)
