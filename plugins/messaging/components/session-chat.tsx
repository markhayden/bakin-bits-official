'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AgentAvatar, IntegratedBrainstorm, readBrainstormSseResponse } from "@bakin/sdk/components"
import type { BrainstormMessage } from "@bakin/sdk/components"
import { Badge } from "@bakin/sdk/ui"
import { useAgent } from "@bakin/sdk/hooks"
import type { ProposedItem, SessionMessage } from '../types'

interface Props {
  sessionId: string
  agentId: string
  initialMessages?: SessionMessage[]
  initialProposals?: ProposedItem[]
  isCompleted?: boolean
  onProposalsReceived?: (proposals: ProposedItem[]) => void
}

function toBrainstorm(agentId: string, sm: SessionMessage): BrainstormMessage {
  return {
    id: sm.id,
    role: sm.role,
    content: sm.content,
    kind: sm.role === 'activity' ? sm.kind : undefined,
    data: sm.role === 'activity' ? sm.data : undefined,
    agentId: sm.role === 'assistant' ? agentId : sm.agentId,
    timestamp: sm.timestamp,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Strip complete ```json proposal blocks from an assistant reply, count how
 * many items are proposed (complete + partial), and return a text for
 * rendering + an optional extras badge. Partial blocks mid-stream show
 * "Planning..." to give the user feedback while the agent is still writing.
 */
function transformAssistantReply(raw: string): { text: string; extras?: ReactNode } {
  let proposalCount = 0
  const complete = raw.match(/```json\s*\n[\s\S]*?```/g)
  if (complete) {
    for (const block of complete) {
      try {
        const jsonStr = block.replace(/^```json\s*\n/, '').replace(/```$/, '').trim()
        const parsed = JSON.parse(jsonStr)
        proposalCount += Array.isArray(parsed) ? parsed.length : 1
      } catch {
        proposalCount += 1
      }
    }
  }
  const parts = raw.split(/```json\s*\n[\s\S]*?```/)
  let hasPartial = false
  const lastPart = parts[parts.length - 1] || ''
  const partialMatch = lastPart.match(/```json\s*\n[\s\S]*$/)
  if (partialMatch) {
    const titleMatches = partialMatch[0].match(/"title"\s*:/g)
    proposalCount += titleMatches ? titleMatches.length : 0
    parts[parts.length - 1] = lastPart.slice(0, lastPart.length - partialMatch[0].length)
    hasPartial = true
  }
  const text = parts
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n')
  let extras: ReactNode = undefined
  if (hasPartial) {
    extras = (
      <Badge variant="outline" className="mt-2 text-[10px]">
        {proposalCount > 0 ? `Planning ${proposalCount} item${proposalCount === 1 ? '' : 's'}…` : 'Preparing proposal…'}
      </Badge>
    )
  } else if (proposalCount > 0) {
    extras = (
      <Badge variant="outline" className="mt-2 text-[10px]">
        {proposalCount} {proposalCount === 1 ? 'item' : 'items'} proposed
      </Badge>
    )
  }
  return { text, extras }
}

export function SessionChat({
  sessionId,
  agentId,
  initialMessages = [],
  isCompleted = false,
  onProposalsReceived,
}: Props) {
  const [messages, setMessages] = useState<BrainstormMessage[]>(() =>
    initialMessages.map((m) => toBrainstorm(agentId, m)),
  )
  const agent = useAgent(agentId)
  const agentName = agent?.name ?? agentId
  // Re-sync only when the session changes (not on every parent re-render;
  // the parent re-creates initialMessages each tick which would otherwise
  // reset our message state infinitely).
  const lastSyncedIdsRef = useRef(initialMessages.map((m) => m.id).join('|'))
  useEffect(() => {
    const idKey = initialMessages.map((m) => m.id).join('|')
    if (idKey === lastSyncedIdsRef.current) return
    lastSyncedIdsRef.current = idKey
    setMessages(initialMessages.map((m) => toBrainstorm(agentId, m)))
  }, [initialMessages, agentId])

  // Component receives opaque custom events; session chat keeps proposal
  // side-effects plugin-owned while the SDK owns the SSE mechanics.
  const onSend = useCallback(
    async (
      prompt: string,
      _history: BrainstormMessage[],
      ctx: {
        signal: AbortSignal
        onToken: (text: string) => void
        onCustom?: (name: string, data: unknown) => void
      },
    ): Promise<{ content: string }> => {
      const res = await fetch(`/api/plugins/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({ message: prompt }),
      })
      return readBrainstormSseResponse(res, ctx, {
        onCustomEvent: (event, data) => {
          if (event === 'proposal' && isRecord(data) && data.proposal) {
            onProposalsReceived?.([data.proposal as ProposedItem])
            ctx.onCustom?.('proposal', data.proposal)
            return true
          }
          if (event === 'proposals' && isRecord(data) && Array.isArray(data.proposals)) {
            onProposalsReceived?.(data.proposals as ProposedItem[])
            for (const p of data.proposals) ctx.onCustom?.('proposal', p)
            return true
          }
          return false
        },
      })
    },
    [sessionId, onProposalsReceived],
  )

  const emptyState = (
    <div className="flex flex-col items-center text-center text-muted-foreground gap-4 px-4">
      <AgentAvatar agentId={agentId} size="xl" />
      <div className="space-y-2 max-w-xl">
        <p className="text-base font-medium text-foreground">Plan with {agentName}</p>
        <p className="text-sm">
          Describe the content you want to plan — topics, themes, dates, or audience. {agentName} will suggest calendar items you can review and approve.
        </p>
      </div>
    </div>
  )

  return (
    <div className="h-full min-h-0 pt-5" data-testid="session-chat-shell">
      <IntegratedBrainstorm
        messages={messages}
        onMessagesChange={setMessages}
        onSend={onSend}
        agentId={agentId}
        placeholder={`Ask ${agentName} for content ideas…`}
        emptyState={emptyState}
        transformAssistantMessage={transformAssistantReply}
        readOnly={isCompleted}
        readOnlyNotice={
          <Badge variant="outline" className="text-muted-foreground">
            Session completed — read-only
          </Badge>
        }
        fitParent
        showHeader={false}
      />
    </div>
  )
}
