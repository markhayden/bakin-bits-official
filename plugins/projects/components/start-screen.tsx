'use client'

/**
 * The start screen (D7/D8): "what kind of project is on your mind?" — a
 * starter chip pre-fills the composer, the lead agent is picked beside it,
 * and the first send creates the project and its first brainstorm turn. No
 * form, nothing created until send.
 */
import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, Button } from '@makinbakin/sdk/ui'
import { AgentSelect, Page, PageBody, PageComposer, PageHeader } from '@makinbakin/sdk/patterns'
import { Composer, ConversationEmptyState, type ComposerHandle } from '@makinbakin/sdk/conversation'
import { useAgentList, useMainAgentId } from '@makinbakin/sdk/hooks'
import { useRouter } from '@makinbakin/sdk/navigation'
import { projectRequest } from '../lib/project-api'
import { STARTER_PROMPTS, fallbackTitle } from '../lib/start'

export function StartScreen({ onBack }: { onBack?: () => void }) {
  const router = useRouter()
  const mainAgentId = useMainAgentId() ?? 'main'
  const agentList = useAgentList()
  const agents = useMemo(() => agentList.map(agent => ({
    id: agent.id,
    name: agent.name ?? agent.id,
    imageSrc: agent.headshot ?? null,
  })), [agentList])
  const [lead, setLead] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composer = useRef<ComposerHandle | null>(null)
  // Minted when the user presses send and reused by every retry of that
  // send, so a lost response can never create a second project (D8).
  const requestId = useRef<string | null>(null)
  const leadId = lead ?? mainAgentId

  const create = async (content: string) => {
    setCreating(true)
    setError(null)
    requestId.current ??= crypto.randomUUID()
    try {
      const result = await projectRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: requestId.current,
          title: fallbackTitle(content),
          owner: leadId,
          firstMessage: content,
        }),
      }) as { id?: unknown }
      if (typeof result.id !== 'string' || !result.id) throw new Error('Projects did not return the new project.')
      requestId.current = null
      router.push(`/projects/${encodeURIComponent(result.id)}`)
    } catch (err) {
      // The composer cleared its draft on send — put the text back.
      composer.current?.setText(content)
      setError(err instanceof Error ? err.message : 'The project could not be created. Try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Page scroll="contained" data-projects-start="">
      <PageHeader
        title="New project"
        navigation={onBack ? (
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to projects">
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : undefined}
      />
      <PageBody gap="content">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-bakin-6">
            <ConversationEmptyState
              headingLevel={2}
              title="What kind of project is on your mind?"
              description="A rough idea is enough — we'll shape it together."
              suggestions={STARTER_PROMPTS.map(starter => starter.label)}
              onSuggestion={(label: string) => {
                const starter = STARTER_PROMPTS.find(entry => entry.label === label)
                if (!starter) return
                composer.current?.setText(starter.prompt)
                composer.current?.focus()
              }}
            />
          </div>
          {error ? (
            <div className="px-bakin-4 pb-bakin-2">
              <Alert tone="danger">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          <PageComposer padding="flush">
            <Composer
              storageKey="projects:new"
              placeholder="Describe your project…"
              inputLabel="Describe your project"
              busy={creating}
              onSend={(content: string) => { void create(content) }}
              handleRef={composer}
              leadingSlot={(
                <AgentSelect
                  value={leadId}
                  onValueChange={setLead}
                  agents={agents}
                  ariaLabel="Lead agent"
                  size="sm"
                  variant="filled"
                />
              )}
            />
          </PageComposer>
        </div>
      </PageBody>
    </Page>
  )
}
