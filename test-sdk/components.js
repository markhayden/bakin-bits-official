import React from 'react'
import { useState } from 'react'

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
