import { useState, type ChangeEvent, type FormEvent } from 'react'
import { Stack } from '@makinbakin/sdk/layout'
import {
  Page,
  PageBody,
  PageHeader,
} from '@makinbakin/sdk/patterns'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Form,
  FormActions,
  Input,
  SubmitButton,
  SystemState,
  Text,
} from '@makinbakin/sdk/ui'
import { pluginFetch } from '@makinbakin/sdk/utils'
import { TEMPLATE_PLUGIN_ID, useTemplateStatus } from './use-template-status'

interface GreetingResponse {
  message?: string
  error?: string
}

async function responseBody(response: Response): Promise<GreetingResponse> {
  return response.json().catch(() => ({})) as Promise<GreetingResponse>
}

/** Minimal plugin-owned detail page composed from public Storybook contracts. */
export function TemplatePage() {
  const { data, error, loading, refresh } = useTemplateStatus()
  const [name, setName] = useState('Plugin builder')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submitGreeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFeedback(null)
    setSubmitting(true)
    try {
      const response = await pluginFetch(TEMPLATE_PLUGIN_ID, '/greet', {
        method: 'POST',
        body: { name: name.trim() },
      })
      const body = await responseBody(response)
      setFeedback(response.ok
        ? { tone: 'success', message: body.message ?? 'The plugin route accepted the request.' }
        : { tone: 'danger', message: body.error ?? `The request failed (${response.status}).` })
    } catch (caught) {
      setFeedback({
        tone: 'danger',
        message: caught instanceof Error ? caught.message : 'The request could not be completed.',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const state = error ? (
    <SystemState
      action={<Button type="button" variant="outline" onClick={refresh}>Retry</Button>}
      description={`The template API did not respond. ${error}`}
      kind="error"
      recovery="available"
      title="Template plugin unavailable"
    />
  ) : loading && data === null ? (
    <SystemState kind="loading" title="Loading template plugin" />
  ) : undefined

  return (
    <Page
      data-template-ui-ready={data?.ok ? '' : undefined}
      width="standard"
    >
      <PageHeader
        description="A minimal plugin-owned page using the same public UI and routing contracts as Bakin."
        eyebrow="Official Bits / author starter"
        meta={<Badge size="xs" variant="outline">API connected</Badge>}
        title="Plugin template"
      />

      <PageBody
        feedback={feedback ? (
          <Alert tone={feedback.tone}>
            <AlertTitle>{feedback.tone === 'success' ? 'Greeting created' : 'Greeting failed'}</AlertTitle>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        ) : undefined}
        state={state}
      >
        <Card>
          <CardHeader>
            <CardTitle>Runtime contract</CardTitle>
            <CardDescription>The page loaded this status through the plugin-scoped API helper.</CardDescription>
          </CardHeader>
          <CardContent>
            <Stack gap="dense">
              <p>Server plugin: <Text mono>{data?.plugin}</Text></p>
              <p>Endpoint: <Text mono>GET /api/plugins/_template/</Text></p>
            </Stack>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Validated mutation</CardTitle>
            <CardDescription>Copy this field, form, busy-state, and feedback composition for your primary action.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form aria-label="Create a greeting" busy={submitting} onSubmit={submitGreeting}>
              <Field name="name">
                <FieldLabel requirement="required">Your name</FieldLabel>
                <FieldDescription>The server validates this value before creating the greeting.</FieldDescription>
                <Input
                  required
                  autoComplete="name"
                  maxLength={80}
                  value={name}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.currentTarget.value)}
                />
              </Field>
              <FormActions>
                <SubmitButton busyLabel="Creating greeting…" disabled={!name.trim()}>
                  Create greeting
                </SubmitButton>
              </FormActions>
            </Form>
          </CardContent>
        </Card>
      </PageBody>
    </Page>
  )
}
