import '@makinbakin/sdk/styles.css'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_PLUGIN_UI_FIXTURE, PluginUiFixtureHost } from '@makinbakin/sdk/testing/ui'
import { emitPluginEvent } from '@makinbakin/sdk/hooks'
import { writeComposerDraft } from '@makinbakin/sdk/conversation'
import { PluginLink } from '@makinbakin/sdk/navigation'
import { ProjectDetailRoute } from '../client'
import { createDetailFixtureState, detailFixtureFetch } from './detail-fixture-data'

class FixtureEventSource extends EventTarget { onmessage = null; close() {} }
globalThis.EventSource = FixtureEventSource as unknown as typeof EventSource
const state = createDetailFixtureState()
const changed = () => emitPluginEvent({ event: 'projects.changed', projectId: 'sample' })
Object.assign(globalThis, { __projectsFixture: { state, changed } })
function Detail(props: { id?: string; pathname?: string; params?: Record<string, string> }) {
  useLayoutEffect(() => {
    const prior = globalThis.fetch
    globalThis.fetch = detailFixtureFetch(state, prior, changed)
    return () => { globalThis.fetch = prior }
  }, [])
  return <ProjectDetailRoute {...props} />
}
function Index() { return <div><h1>Project list fixture</h1><PluginLink to="/projects/sample">Open sample project</PluginLink></div> }
export function mountDetailFixture(mode: 'read' | 'edit' = 'read') {
  const scenario = new URL(location.href).searchParams.get('scenario')
  if (scenario === 'conversation') state.project.brainstormMessages = Array.from({ length: 30 }, (_, index) => ({ kind: 'user' as const, ts: `2026-01-15T10:${String(index).padStart(2, '0')}:00Z`, content: `Conversation message ${index}. A longer message to make the history scroll at a narrow viewport.` }))
  if (scenario === 'draft') writeComposerDraft('project:sample', 'Retained brainstorm draft')
  if (scenario === 'history-error') state.failures['GET /api/plugins/projects/sample/history'] = 1
  createRoot(document.getElementById('root')!).render(<PluginUiFixtureHost fixture={{ ...DEFAULT_PLUGIN_UI_FIXTURE, route: `/projects/sample${mode === 'edit' ? '/edit' : ''}`, network: [] }}
    registrations={[{ id: 'projects', routes: { '/projects': Index, '/projects/[id]': Detail, '/projects/[id]/edit': Detail } }]} />)
}
