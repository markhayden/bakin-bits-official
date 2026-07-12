import React from 'react'
import { useState, useRef, useCallback } from 'react'

export function AgentAvatar({ agentId }) {
  return React.createElement('span', { 'data-testid': agentId ? `avatar-${agentId}` : 'avatar' }, agentId)
}

export function AgentFilter() {
  return null
}

export function AgentSelect({ value, onChange }) {
  return React.createElement('input', {
    'data-testid': 'agent-select',
    value: value ?? '',
    onChange: event => onChange?.(event.target.value),
  })
}

export function BakinDrawer({ children, open = true }) {
  return open ? React.createElement('div', null, children) : null
}

export function ChannelIcon({ channelId }) {
  return React.createElement('span', { 'data-testid': `channel-icon-${channelId ?? 'unknown'}` })
}

export function EmptyState({ title, children }) {
  return React.createElement('div', { 'data-testid': 'empty-state' }, title ?? children)
}

export function FacetFilter() {
  return null
}

// ── Conversation kit stubs (successors to IntegratedBrainstorm) ──────────
// Functional minimums matching the real semantics so consumer components
// exercise real flows: the SSE reader parses real frames, the stream hook
// drives fetcher → chunks → done, and the panel renders messages + input.

export async function readConversationSseStream(response, handlers) {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Server returned ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let finalContent = ''

  function dispatch(frame) {
    if (frame.event === 'chunk') {
      const chunk = frame.data
      if (!chunk || typeof chunk.type !== 'string') return
      if (chunk.type === 'text') accumulated += chunk.content ?? ''
      handlers.onChunk(chunk)
      return
    }
    if (frame.event === 'done') {
      finalContent = typeof frame.data?.content === 'string' ? frame.data.content : accumulated
      return
    }
    if (frame.event === 'error') {
      throw new Error(typeof frame.data?.message === 'string' ? frame.data.message : 'Unknown error')
    }
    handlers.onCustom?.(frame.event, frame.data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const frame = parseSseFrame(part)
      if (frame) dispatch(frame)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) {
    const frame = parseSseFrame(buffer)
    if (frame) dispatch(frame)
  }
  return { content: finalContent || accumulated }
}

function parseSseFrame(frame) {
  let event = 'message'
  const dataLines = []
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const rawData = dataLines.join('\n')
  let data = rawData
  try {
    data = JSON.parse(rawData)
  } catch {}
  return { event, data }
}

export function useConversationStream(options) {
  const [liveChunks, setLiveChunks] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const controllerRef = useRef(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const abort = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const send = useCallback(async (content) => {
    if (controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    setStreaming(true)
    setLiveChunks([])
    const chunks = []
    try {
      const response = await optionsRef.current.fetcher(content, { signal: controller.signal })
      const { content: finalContent } = await readConversationSseStream(response, {
        signal: controller.signal,
        onChunk: (chunk) => {
          chunks.push(chunk)
          setLiveChunks([...chunks])
        },
        onCustom: (event, data) => optionsRef.current.onCustom?.(event, data),
      })
      setLiveChunks(null)
      await optionsRef.current.onDone?.(finalContent)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setLiveChunks(null)
        optionsRef.current.onAborted?.()
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setLiveChunks([...chunks, { type: 'error', content: message }])
        optionsRef.current.onError?.(message)
      }
    } finally {
      controllerRef.current = null
      setStreaming(false)
    }
  }, [])

  return { liveChunks, streaming, send, abort }
}

function messageText(message, transformText) {
  if (message.kind === 'user') return message.content
  if (message.kind === 'assistant') {
    return transformText ? transformText(message.content).text : message.content
  }
  if (message.kind === 'tool') return `${message.toolName}${message.summary ? `: ${message.summary}` : ''}`
  if (message.kind === 'error') return message.message
  if (message.kind === 'aborted') return 'Stopped'
  return ''
}

export function ConversationPanel({
  messages = [],
  liveChunks,
  streaming,
  agentId,
  onAgentChange,
  onSend,
  onAbort,
  readOnly,
  readOnlyNotice,
  placeholder,
  emptyState,
  transformText,
}) {
  const [draft, setDraft] = useState('')
  const liveText = (liveChunks ?? [])
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => chunk.content ?? '')
    .join('')
  const extras = transformText
    ? messages
        .filter((message) => message.kind === 'assistant')
        .map((message, index) => {
          const result = transformText(message.content)
          return result.extras ? React.createElement('span', { key: `extras-${index}` }, result.extras) : null
        })
    : []

  return React.createElement(
    'div',
    { 'data-testid': 'conversation-panel' },
    readOnly && readOnlyNotice ? readOnlyNotice : null,
    messages.length === 0 && !liveText ? emptyState : null,
    ...messages.map((message, index) =>
      React.createElement('div', { key: index, 'data-conv-kind': message.kind }, messageText(message, transformText)),
    ),
    ...extras,
    liveText ? React.createElement('div', { 'data-testid': 'live-text' }, liveText) : null,
    streaming ? React.createElement('div', { 'data-testid': 'thinking' }, 'thinking…') : null,
    onAgentChange && agentId
      ? React.createElement('input', {
        'data-testid': 'agent-select',
        value: agentId,
        onChange: event => onAgentChange(event.target.value),
      })
      : null,
    !readOnly && onSend
      ? React.createElement('textarea', {
        'aria-label': placeholder,
        'data-testid': 'chat-input',
        value: draft,
        onChange: event => setDraft(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            const value = event.currentTarget.value.trim()
            if (value) {
              setDraft('')
              void onSend(value)
            }
          }
          if (event.key === 'Escape' && streaming) onAbort?.()
        },
      })
      : null,
  )
}

export function Conversation({ turns = [] }) {
  return React.createElement('div', { 'data-testid': 'conversation' }, ...turns.map((turn, i) =>
    React.createElement('div', { key: i }, turn.kind === 'user' ? turn.content : null)))
}

export function Composer({ onSend, placeholder }) {
  const [draft, setDraft] = useState('')
  return React.createElement('textarea', {
    'aria-label': placeholder,
    'data-testid': 'chat-input',
    value: draft,
    onChange: event => setDraft(event.target.value),
    onKeyDown: event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const value = event.currentTarget.value.trim()
        if (value) {
          setDraft('')
          void onSend?.(value)
        }
      }
    },
  })
}

export function ConversationEmptyState({ title, description }) {
  return React.createElement('div', { 'data-testid': 'conversation-empty' }, title, description)
}

export function ThinkingIndicator({ label = 'thinking' }) {
  return React.createElement('div', { 'data-testid': 'thinking' }, `${label}…`)
}

export function foldConversation(messages = [], opts = {}) {
  const turns = messages.map((message, index) => ({ kind: message.kind === 'user' ? 'user' : 'agent', key: String(index), items: [], status: 'complete' }))
  if (opts.liveChunks) turns.push({ kind: 'agent', key: 'live', items: [], status: 'streaming' })
  return turns
}

export function MarkdownEditor({ value = '', onChange }) {
  return React.createElement('textarea', { value, onChange: event => onChange?.(event.target.value) })
}

export function PluginHeader({ title, search, actions, children }) {
  return React.createElement(
    'header',
    null,
    React.createElement('h1', null, title),
    search
      ? React.createElement('input', {
        'data-testid': 'plugin-search-input',
        value: search.value ?? '',
        placeholder: search.placeholder,
        onChange: event => search.onChange?.(event.target.value),
      })
      : null,
    actions,
    children,
  )
}

export function SortableHead({ children, onSort, field }) {
  return React.createElement('th', { onClick: () => onSort?.(field) }, children)
}
