import { MarkdownContent, MarkdownEditor } from '@makinbakin/sdk/content'
import type { ProjectHistory } from '../hooks/use-project-history'
import { HistoryFeedback } from './history-feedback'

/** Complete documents go through the canonical parser, including comparison. */
export function RenderedPlan({ historyState, body, hintsEnabled = true }: {
  historyState: ProjectHistory
  body: string
  hintsEnabled?: boolean
}) {
  const compareTo = hintsEnabled && !historyState.loading && !historyState.error
    ? historyState.history?.at(-1)?.body : undefined
  return <div data-testid="rendered-plan">
    {hintsEnabled && <HistoryFeedback state={historyState} />}
    {body.trim() || compareTo !== undefined
      ? <MarkdownContent content={body} compareTo={compareTo} />
      : <MarkdownEditor content={body} editing={false} onChange={() => {}} placeholder="Project details, goals, background..." format="markdown" />}
  </div>
}
