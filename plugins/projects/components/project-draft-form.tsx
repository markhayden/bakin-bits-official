import { AgentSelect, SaveBar } from '@makinbakin/sdk/patterns'
import type { AgentSelectOption } from '@makinbakin/sdk/patterns'
import { Alert, AlertDescription, AlertTitle, Button, Field, FieldLabel, Fieldset, FieldsetLegend, Form, Input, Radio, RadioGroup, Text } from '@makinbakin/sdk/ui'
import type { FormEvent } from 'react'
import type { useProjectDraft } from '../hooks/use-project-draft'
import { projectFields } from '../lib/project-draft'
import { PROJECT_STATUSES } from '../types'
import { ProjectEditor } from './project-editor'

const labels = { title: 'Title', owner: 'Owner', status: 'Status', body: 'Plan' }
export function ProjectDraftForm({ model, agents }: {
  model: ReturnType<typeof useProjectDraft>
  agents: readonly AgentSelectOption[]
}) {
  const values = model.draft.values
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void model.save() }
  return <Form aria-label="Edit project" busy={model.saving} onSubmit={submit}>
    <Field name="title">
      <FieldLabel requirement="required">Project title</FieldLabel>
      <Input size="lg" variant="outlined" value={values.title} required aria-label="Project title"
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => model.edit('title', event.target.value)} />
    </Field>
    <Field name="owner">
      <FieldLabel>Owner</FieldLabel>
      <AgentSelect value={values.owner} onValueChange={value => model.edit('owner', value)} agents={agents}
        size="md" variant="outlined" ariaLabel="Project owner" />
    </Field>
    <Fieldset>
      <FieldsetLegend>Status</FieldsetLegend>
      <RadioGroup aria-label="Project status" value={values.status} onValueChange={(value: typeof values.status) => model.edit('status', value)} className="flex flex-wrap gap-bakin-4">
        {PROJECT_STATUSES.map(status => <label key={status} className="flex items-center gap-bakin-2"><Radio value={status} />{status[0]!.toUpperCase() + status.slice(1)}</label>)}
      </RadioGroup>
      <Text size="meta" tone="muted">Status is independent of checklist progress.</Text>
    </Fieldset>
    <ProjectEditor body={values.body} editing onChange={body => model.edit('body', body)} />
    {projectFields.map(field => {
      const conflict = model.draft.conflicts[field]
      if (!conflict) return null
      return <Alert key={field} tone="attention">
        <AlertTitle>{labels[field]} changed while you were editing</AlertTitle>
        <AlertDescription>
          <div className="grid min-w-0 gap-bakin-3">
            <div><Text weight="medium">Your value</Text><div className="max-h-48 overflow-auto whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-bakin-focus-ring focus-visible:-outline-offset-2" role="region" aria-label={`Your ${labels[field].toLowerCase()}`} tabIndex={0}>{conflict.local || '(empty)'}</div></div>
            <div><Text weight="medium">Latest value</Text><div className="max-h-48 overflow-auto whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-bakin-focus-ring focus-visible:-outline-offset-2" role="region" aria-label={`Latest ${labels[field].toLowerCase()}`} tabIndex={0}>{conflict.latest || '(empty)'}</div></div>
            <div className="flex flex-wrap gap-bakin-2">
              <Button type="button" size="sm" variant="outline" disabled={model.saving} onClick={() => model.resolve(field, 'latest')}>Use latest {labels[field].toLowerCase()}</Button>
              <Button type="button" size="sm" variant="outline" disabled={model.saving} onClick={() => model.resolve(field, 'mine')}>Keep my {labels[field].toLowerCase()}</Button>
            </div>
          </div>
        </AlertDescription>
      </Alert>
    })}
    <SaveBar dirty={model.dirty} saving={model.saving} error={model.error} onSave={() => { void model.save() }} onDiscard={model.discard}>
      Project title, owner, status and plan
    </SaveBar>
  </Form>
}
