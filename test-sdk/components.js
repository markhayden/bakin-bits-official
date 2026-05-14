import React from 'react'
import { useState } from 'react'

export function brainstormThreadId(scope, entityId, agentId) {
  return [scope, entityId, agentId].map(value => encodeURIComponent(String(value).trim() || 'default')).join(':')
}

export function normalizeBrainstormActivityForStorage(activity) {
  const content = typeof activity?.content === 'string' ? activity.content.trim() : ''
  if (!content) return null
  return {
    kind: typeof activity.kind === 'string' && activity.kind ? activity.kind : 'runtime_status',
    content,
    ...(activity.data !== undefined ? { data: activity.data } : {}),
  }
}

export function normalizeBrainstormActivityMessageForStorage(activity) {
  const normalized = normalizeBrainstormActivityForStorage(activity)
  if (!normalized) return null
  return {
    role: 'activity',
    kind: normalized.kind,
    content: normalized.content,
    ...(normalized.data !== undefined ? { data: normalized.data } : {}),
  }
}

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

export function IntegratedBrainstorm({
  messages = [],
  children,
  emptyState,
  readOnly,
  readOnlyNotice,
  placeholder,
  onSend,
}) {
  const [draft, setDraft] = useState('')
  const [localMessages, setLocalMessages] = useState([])
  const [error, setError] = useState(null)
  const renderedMessages = [...messages, ...localMessages]

  async function submit(value = draft) {
    const prompt = value.trim()
    if (!prompt || readOnly || !onSend) return
    setDraft('')
    setError(null)
    let streamed = ''
    try {
      const result = await onSend(prompt, renderedMessages, {
        signal: new AbortController().signal,
        onToken: text => { streamed += text },
        onCustom: () => {},
      })
      setLocalMessages(prev => [
        ...prev,
        { id: `user-${prev.length}`, role: 'user', content: prompt },
        { id: `assistant-${prev.length}`, role: 'assistant', content: result?.content ?? streamed },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return React.createElement(
    'div',
    { 'data-testid': 'integrated-brainstorm' },
    readOnly && readOnlyNotice ? readOnlyNotice : null,
    renderedMessages.length === 0 ? emptyState : null,
    ...renderedMessages.map((message, index) => React.createElement('div', { key: message.id ?? index }, message.content)),
    error ? React.createElement('div', { role: 'alert' }, error) : null,
    !readOnly && onSend
      ? React.createElement('textarea', {
        'aria-label': placeholder,
        'data-testid': 'chat-input',
        value: draft,
        onChange: event => setDraft(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void submit(event.currentTarget.value)
          }
        },
      })
      : null,
    children,
  )
}

export async function readBrainstormSseResponse(response, ctx, options = {}) {
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
    if (frame.event === 'token') {
      const text = typeof frame.data?.text === 'string' ? frame.data.text : ''
      accumulated += text
      ctx.onToken(text)
      return
    }
    if (frame.event === 'activity') {
      ctx.onCustom?.('activity', frame.data)
      return
    }
    if (frame.event === 'done') {
      finalContent = typeof frame.data?.content === 'string' ? frame.data.content : accumulated
      return
    }
    if (frame.event === 'error') {
      throw new Error(typeof frame.data?.message === 'string' ? frame.data.message : 'Unknown error')
    }
    if (options.onCustomEvent?.(frame.event, frame.data) === true) return
    ctx.onCustom?.(frame.event, frame.data)
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
