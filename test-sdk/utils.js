export function cn(...args) {
  return args.filter(Boolean).join(' ')
}

export function formatAge(value) {
  return String(value)
}

export function formatSize(bytes) {
  return `${bytes} B`
}

// ── Conversation kit server helpers (functional ports of the real SDK —
// server routes under test run against these for real) ────────────────────

export const SUMMARY_MAX_CHARS = 500
export const PREVIEW_MAX_CHARS = 2000

export function conversationThreadId(scope, entityId, agentId) {
  return [scope, entityId, agentId]
    .map(value => encodeURIComponent(String(value).trim() || 'default'))
    .join(':')
}

function clip(value, max) {
  if (value.length <= max) return { value, clipped: false }
  return { value: `${value.slice(0, Math.max(0, max - 1))}…`, clipped: true }
}

export function createTurnRecorder({ turnId, agentId, now }) {
  const stamp = now ?? (() => new Date().toISOString())
  const rows = []
  const callPhase = new Map()
  let pendingText = ''
  let drained = 0

  const base = () => ({
    ts: stamp(),
    turnId,
    ...(agentId ? { agentId } : {}),
  })

  const flushText = () => {
    if (!pendingText.trim()) {
      pendingText = ''
      return
    }
    rows.push({ kind: 'assistant', ...base(), content: pendingText })
    pendingText = ''
  }

  const ingest = (chunk) => {
    switch (chunk.type) {
      case 'text':
        pendingText += chunk.content ?? ''
        break
      case 'tool': {
        const data = chunk.data
        if (!data?.toolName) break
        if (data.phase === 'call') {
          if (data.callId) callPhase.set(data.callId, data)
          break
        }
        flushText()
        const call = data.callId ? callPhase.get(data.callId) : undefined
        const summaryRaw = data.summary ?? call?.summary
        const inputRaw = data.inputPreview ?? call?.inputPreview
        const outputRaw = data.outputPreview
        const summary = summaryRaw ? clip(summaryRaw, SUMMARY_MAX_CHARS) : undefined
        const input = inputRaw ? clip(inputRaw, PREVIEW_MAX_CHARS) : undefined
        const output = outputRaw ? clip(outputRaw, PREVIEW_MAX_CHARS) : undefined
        const truncated = Boolean(summary?.clipped || input?.clipped || output?.clipped)
        rows.push({
          kind: 'tool',
          ...base(),
          ...(data.callId ? { callId: data.callId } : {}),
          toolName: data.toolName,
          status: data.status === 'failed' ? 'failed' : 'completed',
          ...(summary ? { summary: summary.value } : {}),
          ...(input ? { inputPreview: input.value } : {}),
          ...(output ? { outputPreview: output.value } : {}),
          ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
          ...(data.metadata || truncated
            ? { metadata: { ...(data.metadata ?? {}), ...(truncated ? { truncated: true } : {}) } }
            : {}),
        })
        break
      }
      case 'error':
        flushText()
        rows.push({
          kind: 'error',
          ...base(),
          message: chunk.content || 'turn failed',
          ...(typeof chunk.data?.kind === 'string' ? { errorKind: chunk.data.kind } : {}),
        })
        break
      default:
        break
    }
  }

  return {
    ingest,
    drain: () => {
      const fresh = rows.slice(drained)
      drained = rows.length
      return fresh
    },
    finish: () => {
      flushText()
      const fresh = rows.slice(drained)
      drained = rows.length
      return fresh
    },
  }
}
