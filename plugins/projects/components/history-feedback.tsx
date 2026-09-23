import { Button, SystemState } from '@makinbakin/sdk/ui'
import type { ProjectHistory } from '../hooks/use-project-history'

export function HistoryFeedback({ state }: { state: ProjectHistory }) {
  if (state.error) return <SystemState kind="error" scope="inline" recovery="available" headingLevel={3}
    title="Plan history unavailable" description={state.error.message}
    action={<Button size="sm" variant="outline" onClick={() => { void state.refresh() }}>Try again</Button>} />
  if (state.loading) return <SystemState kind="loading" scope="inline" headingLevel={3} title="Loading history" />
  return null
}
