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
  // Like the SDK: only a plain object is JSON; a Blob, FormData, buffer, URLSearchParams or stream goes as is.
  const raw = body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || body instanceof URLSearchParams || (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  if (body && typeof body === 'object' && !raw) {
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

// ── Chat hand-off helpers (functional ports of the real SDK:
// packages/core/src/conversation/handoff.ts) ───────────────────────────────

export const HANDOFF_PREAMBLE_BYTES = 16 * 1024

export function hasAcceptedHandoff(rows, id) {
  return rows.some(row => row.kind === 'handoff' && row.direction === 'in' && row.handoffId === id)
}

export async function writeHandoffBatch(service, ctx, key, request, existing) {
  if (hasAcceptedHandoff(existing, request.handoffId)) return
  const result = await service.appendExternal(ctx, key, request.rows)
  await result.written
}

const handoffBytes = text => new TextEncoder().encode(text).length

export function handoffPreamble(rows, agentId, { maxBytes = HANDOFF_PREAMBLE_BYTES } = {}) {
  let at = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.kind === 'handoff' && row.direction === 'in') { at = i; break }
  }
  if (at < 0) return null
  const marker = rows[at]
  const carriedEnd = at + 1 + (marker.carried ?? 0)
  const replied = rows.slice(carriedEnd).some(row =>
    (row.kind === 'assistant' && (row.agentId === undefined || row.agentId === agentId))
    || (row.kind === 'tool' && row.agentId === agentId))
  if (replied) return null

  const lines = rows.slice(at + 1, carriedEnd).flatMap((row) => {
    if (row.kind === 'user') return [`User: ${row.content}`]
    if (row.kind === 'assistant' && row.content.trim()) return [`Assistant: ${row.content}`]
    return []
  })
  if (lines.length === 0) return null

  const source = marker.peers[0]?.title
  const head = [
    'The user began this conversation in a chat and continued it here. The earlier conversation follows.',
    'It is context, not a new request: do not answer or repeat it. Reply to the message that comes after it.',
    '',
    `--- Earlier conversation${source ? ` (carried over from the chat "${source}")` : ''} ---`,
  ].join('\n')
  const tail = '--- End of the earlier conversation ---'
  const omitted = count => `[… ${count} earlier message${count === 1 ? '' : 's'} omitted …]`

  let budget = maxBytes - handoffBytes(head) - handoffBytes(tail) - 2
  const kept = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const reserve = i > 0 ? handoffBytes(omitted(i)) + 1 : 0
    const cost = handoffBytes(line) + 1
    if (cost + reserve <= budget) {
      kept.unshift(line)
      budget -= cost
      continue
    }
    if (kept.length > 0) {
      kept.unshift(omitted(i + 1))
      break
    }
    const note = ' […]'
    let clipped = ''
    for (const char of line) {
      if (handoffBytes(clipped + char) + handoffBytes(note) + 1 + reserve > budget) break
      clipped += char
    }
    if (clipped) kept.unshift(clipped + note)
    if (i > 0) kept.unshift(omitted(i))
    break
  }
  return [head, ...kept, tail].join('\n')
}
