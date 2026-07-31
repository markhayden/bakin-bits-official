import React from 'react'
import { useState } from 'react'

// Focused conversation-kit stubs mirroring `@makinbakin/sdk/conversation`.
// Functional minimums matching the real semantics: the panel renders the
// persisted rows + live text and drives onSend/onAbort through a composer,
// while identity comes from consumer-supplied `agent`/`resolveAgent` — the
// focused kit never reads host stores.

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
  chrome,
  autoFocus,
  className,
  messages = [],
  liveChunks,
  streaming,
  agent,
  resolveAgent,
  agentControl,
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
  const identity = agent ?? resolveAgent?.(undefined)

  return React.createElement(
    'div',
    {
      'data-testid': 'conversation-panel',
      'data-chrome': chrome,
      'data-agent': identity?.id ?? identity?.name,
      'data-auto-focus': autoFocus == null ? undefined : String(autoFocus),
      className,
    },
    readOnly && readOnlyNotice ? readOnlyNotice : null,
    messages.length === 0 && !liveText ? emptyState : null,
    ...messages.map((message, index) =>
      React.createElement('div', { key: index, 'data-conv-kind': message.kind }, messageText(message, transformText)),
    ),
    ...extras,
    liveText ? React.createElement('div', { 'data-testid': 'live-text' }, liveText) : null,
    streaming ? React.createElement('div', { 'data-testid': 'thinking' }, 'thinking…') : null,
    agentControl ?? null,
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
  const turns = messages.map((message, index) => ({
    kind: message.kind === 'user' ? 'user' : 'agent',
    key: String(index),
    items: [],
    status: 'complete',
  }))
  if (opts.liveChunks) turns.push({ kind: 'agent', key: 'live', items: [], status: 'streaming' })
  return turns
}
