'use client'

/**
 * Plan tab (D12): the rendered plan, its change history, and Edit plan —
 * the editor and one SaveBar in place of the rendered view. The draft lives
 * at page level, so switching tabs never loses it.
 */
import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle, Button, Field, FieldLabel, Form, Switch, Text, Textarea } from '@makinbakin/sdk/ui'
import { SaveBar, SegmentedControl } from '@makinbakin/sdk/patterns'
import type { FormEvent } from 'react'
import type { ProjectHistory } from '../../hooks/use-project-history'
import type { PlanDraftModel } from '../../hooks/use-plan-draft'
import type { ProjectDetailData } from '../../types'
import { PlanHistoryPanel } from '../plan-history'
import { ProjectEditor } from '../project-editor'
import { RenderedPlan } from '../rendered-plan'

const HINTS_KEY = 'projects-show-change-hints'

export type PlanView = 'rendered' | 'changes'

export function PlanTab({
  project,
  history,
  draft,
  editing,
  onEditingChange,
  view,
  onViewChange,
  compareRevision,
  onRestored,
}: {
  project: ProjectDetailData
  history: ProjectHistory
  draft: PlanDraftModel
  editing: boolean
  onEditingChange: (editing: boolean) => void
  view: PlanView
  onViewChange: (view: PlanView) => void
  /** The seen baseline "Review changes" compares against. */
  compareRevision?: number
  onRestored: () => Promise<unknown>
}) {
  const [hints, setHints] = useState(() => {
    try { return localStorage.getItem(HINTS_KEY) !== 'false' } catch { return true }
  })
  const toggleHints = (next: boolean) => {
    setHints(next)
    try { localStorage.setItem(HINTS_KEY, String(next)) } catch { /* private mode */ }
  }

  if (editing) {
    const conflict = draft.draft.conflict
    const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void draft.save() }
    return (
      <Form aria-label="Edit plan" busy={draft.saving} onSubmit={submit}>
        <div className="flex flex-wrap items-center justify-between gap-bakin-3">
          <h2>Plan</h2>
          <Button type="button" variant="secondary" size="sm" disabled={draft.dirty || draft.saving} onClick={() => onEditingChange(false)}>
            Done editing
          </Button>
        </div>
        <ProjectEditor body={draft.draft.value} editing onChange={draft.edit} />
        {conflict ? (
          <Alert tone="attention">
            <AlertTitle>The plan changed while you were editing</AlertTitle>
            <AlertDescription>
              <div className="grid min-w-0 gap-bakin-3">
                <Field name="plan-mine">
                  <FieldLabel>Your plan</FieldLabel>
                  <Textarea readOnly size="sm" rows={6} value={conflict.local || '(empty)'} />
                </Field>
                <Field name="plan-latest">
                  <FieldLabel>Latest plan</FieldLabel>
                  <Textarea readOnly size="sm" rows={6} value={conflict.latest || '(empty)'} />
                </Field>
                <div className="flex flex-wrap gap-bakin-2">
                  <Button type="button" size="sm" variant="outline" disabled={draft.saving} onClick={() => draft.resolve('latest')}>Use latest plan</Button>
                  <Button type="button" size="sm" variant="outline" disabled={draft.saving} onClick={() => draft.resolve('mine')}>Keep my plan</Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        <SaveBar dirty={draft.dirty} saving={draft.saving} error={draft.error} onSave={() => { void draft.save() }} onDiscard={draft.discard}>
          Project plan
        </SaveBar>
      </Form>
    )
  }

  return (
    <section aria-labelledby="project-plan-heading" className="flex min-w-0 flex-col gap-bakin-3">
      <div className="flex flex-wrap items-center justify-between gap-bakin-3">
        <h2 id="project-plan-heading">Plan</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-bakin-3">
          {view === 'rendered' ? (
            <Field orientation="horizontal" name="showChangeHints">
              <Switch size="sm" checked={hints} onCheckedChange={toggleHints} />
              <FieldLabel>Show changes</FieldLabel>
            </Field>
          ) : null}
          <SegmentedControl
            options={[{ value: 'rendered', label: 'Rendered' }, { value: 'changes', label: 'History' }]}
            value={view}
            onValueChange={(value: string) => onViewChange(value === 'changes' ? 'changes' : 'rendered')}
            ariaLabel="Plan view"
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => onEditingChange(true)}>
            <Pencil aria-hidden="true" />
            Edit plan
          </Button>
        </div>
      </div>
      {view === 'changes' ? (
        <PlanHistoryPanel projectId={project.id} currentBody={project.body} historyState={history} compareRevision={compareRevision} onRestored={async () => { await onRestored() }} />
      ) : project.body.trim() ? (
        <RenderedPlan historyState={history} body={project.body} hintsEnabled={hints} />
      ) : (
        <Text as="p" tone="muted">No plan yet. Your lead drafts one in the conversation once the project takes shape — or write it yourself with Edit plan.</Text>
      )}
    </section>
  )
}
