import { Stack } from '@makinbakin/sdk/layout'
import { PluginLink } from '@makinbakin/sdk/navigation'
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SystemState,
  buttonVariants,
} from '@makinbakin/sdk/ui'
import { useTemplateStatus } from './use-template-status'

/** Copyable `home-widget` contribution backed by the plugin's real API. */
export function TemplateWidget() {
  const { data, error, loading, refresh } = useTemplateStatus()

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Plugin template</CardTitle>
        <CardDescription>A host slot rendered by an independently shipped plugin.</CardDescription>
        <CardAction>
          <Badge size="xs" variant="outline">{data?.ok ? 'Ready' : 'Checking'}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <SystemState
            action={<Button size="xs" type="button" variant="outline" onClick={refresh}>Retry</Button>}
            description={error}
            headingLevel={3}
            kind="error"
            recovery="available"
            scope="inline"
            title="Template unavailable"
          />
        ) : loading && data === null ? (
          <SystemState headingLevel={3} kind="loading" scope="inline" title="Checking template" />
        ) : (
          <Stack gap="dense">
            <p>The example server route is responding.</p>
            <PluginLink className={buttonVariants({ size: 'sm', variant: 'outline' })} to="/_template">
              Open template page
            </PluginLink>
          </Stack>
        )}
      </CardContent>
    </Card>
  )
}
