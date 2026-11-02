export function cn(...args) {
  return args.filter(Boolean).join(' ')
}

export const OPERATOR_DECLARATION_HEADERS = Object.freeze({ 'X-Bakin-Operator': 'declared' })

export function formatAge(value) {
  return String(value)
}

export function formatSize(bytes) {
  return `${bytes} B`
}

export function pluginFetch(pluginId, path, init = {}) {
  const clean = path.startsWith('/') ? path.slice(1) : path
  const headers = new Headers(init.headers)
  let body = init.body
  if (body && typeof body === 'object') {
    body = JSON.stringify(body)
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`/api/plugins/${pluginId}/${clean}`, { ...init, headers, body })
}

export function healthHealthy(input) {
  return { ...input, status: 'healthy' }
}

export function healthObserved(observations) {
  return { outcome: 'observed', observations }
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

// Functional port of @bakin/core/format formatDateTime (calendar-aware absolute time).
export function formatDateTime(timestamp) {
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return timestamp
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffDays === 0) return `Today ${time}`
  if (diffDays === 1) return `Yesterday ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })} ${time}`
}

// Structured-question validation (mirrors core `questions.ts` field limits).
export const QUESTION_LIMITS = Object.freeze({
  question: 200, label: 60, description: 160, minOptions: 2, maxOptions: 5, serializedBytes: 2048,
})

const QUESTION_KEYS = new Set(['question', 'options', 'recommended', 'allowOther'])
const ENVELOPE_KEYS = new Set(['v', 'id', ...QUESTION_KEYS])

function questionFieldsError(value, allowedKeys = QUESTION_KEYS) {
  if (!value || typeof value !== 'object') return 'invalid question'
  if (Object.keys(value).some(key => !allowedKeys.has(key))) return 'unknown field'
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
  if (!text(value.question, QUESTION_LIMITS.question)) return 'question: invalid'
  const options = value.options
  if (!Array.isArray(options) || options.length < QUESTION_LIMITS.minOptions || options.length > QUESTION_LIMITS.maxOptions) {
    return 'options: invalid'
  }
  for (const option of options) {
    if (!option || !text(option.label, QUESTION_LIMITS.label)) return 'options: invalid label'
    if (option.description !== undefined && !text(option.description, QUESTION_LIMITS.description)) return 'options: invalid description'
  }
  if (value.recommended !== undefined
    && !(Number.isInteger(value.recommended) && value.recommended >= 0 && value.recommended < options.length)) {
    return 'recommended must index one of the options'
  }
  const labels = options.map(option => option.label.toLowerCase())
  if (new Set(labels).size !== labels.length) return 'options: option labels must be unique'
  // Measured as the minted envelope, like the real schema.
  const envelope = { v: 1, id: 'q_0000000000000000', ...value }
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > QUESTION_LIMITS.serializedBytes) return 'question is too large'
  return null
}

export function validateBakinQuestionInput(value) {
  const error = questionFieldsError(value)
  if (error) return { ok: false, error }
  return { ok: true, value: { ...value, allowOther: value.allowOther ?? true } }
}

export function parseBakinQuestion(value) {
  if (questionFieldsError(value, ENVELOPE_KEYS)) return null
  if (value.v !== 1 || typeof value.id !== 'string' || !/^q_[a-z0-9]{16}$/.test(value.id)) return null
  if (typeof value.allowOther !== 'boolean') return null
  return value
}
