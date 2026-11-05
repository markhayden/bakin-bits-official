'use client'

/**
 * The start screen (D7/D8, projects-grill-start D1–D2): "what kind of
 * project is on your mind?" — a starter chip pre-fills the composer with a
 * complete prompt, the lead agent is picked beside it, and the first send
 * creates the project and opens it at once; the first brainstorm turn
 * starts on the server, detached. No form, nothing created until send, and
 * the create never spins past its timeout.
 */
import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, Button } from '@makinbakin/sdk/ui'
import { AgentSelect, Page, PageBody, PageComposer, PageHeader } from '@makinbakin/sdk/patterns'
import { Composer, ConversationEmptyState, writeComposerDraft, type ComposerHandle } from '@makinbakin/sdk/conversation'
import { useAgentList, useMainAgentId } from '@makinbakin/sdk/hooks'
import { useRouter } from '@makinbakin/sdk/navigation'
import { projectRequest } from '../lib/project-api'
import { newRequestId } from '../lib/request-id'
import { CREATE_TIMEOUT_MS, STARTER_PROMPTS, fallbackTitle } from '../lib/start'

type PendingCreate = { requestId: string; message: string }
const PENDING_KEY = 'projects:new:pending'

/** The unconfirmed first send survives a reload, so its retry still dedupes. */
function readPending(): PendingCreate | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Partial<PendingCreate> | null
    return parsed && typeof parsed.requestId === 'string' && typeof parsed.message === 'string' ? { requestId: parsed.requestId, message: parsed.message } : null
  } catch {
    return null
  }
}
function writePending(value: PendingCreate | null): void {
  try {
    if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // Private mode: the in-memory copy still dedupes retries in this visit.
  }
}

export function StartScreen({ onBack, createTimeoutMs = CREATE_TIMEOUT_MS }: { onBack?: () => void; createTimeoutMs?: number }) {
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
  // The first send's payload, minted when the user presses send. Every retry
  // — including after a reload — re-sends it UNCHANGED (same requestId, same
  // message), so a lost response can never create a second project or
  // silently drop an edit (D8).
  const pending = useRef<PendingCreate | null>(readPending())
  const leadId = lead ?? mainAgentId

  const create = async (content: string) => {
    setCreating(true)
    setError(null)
    // Whether the request left the browser: a failure before that clears the
    // composer in the same tick (its draft ref lags a render), so the text is
    // restored unconditionally; after it, only an untouched composer is.
    let sent = false
    try {
      // Minted inside the try: whatever throws here must surface as an error
      // below, never leave the composer locked on "Sending…".
      if (!pending.current) {
        pending.current = { requestId: newRequestId(), message: content }
        writePending(pending.current)
      }
      const { requestId, message } = pending.current
      // The create only writes the project (the first turn starts detached,
      // D1), so an answer that takes longer than this is a stall, not work.
      sent = true
      const result = await projectRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, title: fallbackTitle(message), owner: leadId, firstMessage: message }),
        signal: AbortSignal.timeout(createTimeoutMs),
      }) as { id?: unknown }
      if (typeof result.id !== 'string' || !result.id) throw new Error('Projects did not return the new project.')
      pending.current = null
      writePending(null)
      // Text edited after the first attempt is not lost: it waits in the
      // project's composer as a draft.
      if (content !== message) writeComposerDraft(`project:${result.id}`, content)
      router.push(`/projects/${encodeURIComponent(result.id)}`)
    } catch (err) {
      // The composer cleared its draft on send — put the text back, unless
      // newer text was typed while the request was out.
      if (!sent || (composer.current?.isEmpty() ?? true)) composer.current?.setText(content)
      // A timeout proves nothing about the create: the retry re-sends the
      // SAME request id, and the receipt dedupes.
      const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
      setError(timedOut ? 'Projects did not answer. Retry — your text is kept.' : err instanceof Error ? err.message : 'The project could not be created. Try again.')
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
              // Nothing edits the message while it is being created.
              onSuggestion={creating ? undefined : (label: string) => {
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
              disabled={creating}
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
