/**
 * SessionMessage → conversation-kit row mapping — ONE implementation for
 * every messaging surface (brainstorm view, plan workspace). The
 * engine-era activity kinds map onto the kit's honest markers: turn
 * failures render as error rows and aborts as the kit's aborted notice
 * (they were invisible when only kind === 'error' matched — bakin#703
 * review).
 */
import type { ConversationMessage } from '@makinbakin/sdk/components'
import type { SessionMessage } from '../types'

export function sessionMessageToConversation(agentId: string, message: SessionMessage): ConversationMessage | null {
  if (message.role === 'user') {
    return { kind: 'user', ts: message.timestamp, content: message.content }
  }
  if (message.role === 'assistant') {
    if (!message.content) return null // pure-JSON placeholder rows carry only proposal links
    return { kind: 'assistant', ts: message.timestamp, agentId, content: message.content }
  }
  if (message.role === 'activity') {
    if (message.kind === 'turn_error') {
      return {
        kind: 'error',
        ts: message.timestamp,
        message: message.content.replace(/^Turn failed: /, ''),
      }
    }
    if (message.kind === 'turn_aborted') {
      return { kind: 'aborted', ts: message.timestamp }
    }
    if (message.kind === 'tool_call') {
      const data = (message.data ?? {}) as {
        callId?: string
        toolName?: string
        status?: string
        summary?: string
        inputPreview?: string
        outputPreview?: string
        durationMs?: number
      }
      return {
        kind: 'tool',
        ts: message.timestamp,
        agentId,
        toolName: data.toolName ?? 'tool',
        status: data.status === 'failed' ? 'failed' : 'completed',
        ...(data.callId ? { callId: data.callId } : {}),
        summary: data.summary ?? message.content,
        ...(data.inputPreview ? { inputPreview: data.inputPreview } : {}),
        ...(data.outputPreview ? { outputPreview: data.outputPreview } : {}),
        ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
      }
    }
    if (message.kind === 'error') {
      return { kind: 'error', ts: message.timestamp, message: message.content }
    }
    return null // runtime_status rows are ephemeral color, not transcript
  }
  return null
}
