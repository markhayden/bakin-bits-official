import React from 'react'
import { useState, useRef, useCallback, useEffect } from 'react'
import { usePluginEvent, useNavBadge, toast, useAgent, useRouter } from './hooks.js'

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

// ── Reply toast (#703) — avatar + "<agent> title" + preview; click dismisses
// then router-pushes, test marker attr preserved. ──

export function ConversationReplyToast({ agentId, title, preview, to, onNavigate, testId }) {
  const agent = useAgent(agentId)
  const router = useRouter()
  return React.createElement(
    'button',
    {
      type: 'button',
      ...(testId ? { [testId.attr]: testId.value } : {}),
      onClick: () => {
        onNavigate?.()
        router.push(to)
      },
    },
    React.createElement('span', { 'data-testid': agentId ? `avatar-${agentId}` : 'avatar' }, agentId),
    React.createElement('span', null, `${agent?.name ?? agentId} ${title}`),
    preview ? React.createElement('span', null, preview) : null,
  )
}

// ── useConversationThread (#703) — functional minimum mirroring the real
// bus-driven hook: optimistic user echo, plugin-event chunk accumulation
// with same-format text coalescing, active-thread guards, settle-by-refetch,
// server-seeded streaming rehydration. ──

export function useConversationThread(options) {
  const { threadKey, events } = options
  const [messages, setMessages] = useState([])
  const [meta, setMeta] = useState(null)
  const [liveChunks, setLiveChunks] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const [sendError, setSendError] = useState(null)
  const activeKeyRef = useRef(threadKey)
  activeKeyRef.current = threadKey
  const optionsRef = useRef(options)
  optionsRef.current = options

  const loadTranscript = useCallback(async () => {
    if (!threadKey) {
      setMeta(null)
      setMessages([])
      return
    }
    const body = await optionsRef.current.load(threadKey)
    if (!body || activeKeyRef.current !== threadKey) return
    setMeta(body.meta ?? null)
    setMessages(body.messages)
    if (body.streaming) {
      setStreaming(true)
      setLiveChunks(prev => prev ?? [])
    }
  }, [threadKey])

  useEffect(() => {
    setLiveChunks(null)
    setStreaming(false)
    setSendError(null)
    void loadTranscript()
  }, [loadTranscript])

  usePluginEvent(events.chunk, payload => {
    if (optionsRef.current.keyOf(payload) !== activeKeyRef.current) return
    const chunk = payload.chunk
    if (!chunk?.type) return
    setStreaming(true)
    setLiveChunks(prev => {
      const chunks = prev ?? []
      const last = chunks[chunks.length - 1]
      if (
        chunk.type === 'text' && chunk.content &&
        last?.type === 'text' && (last.format ?? 'markdown') === (chunk.format ?? 'markdown')
      ) {
        return [...chunks.slice(0, -1), { ...last, content: (last.content ?? '') + chunk.content }]
      }
      return [...chunks, chunk]
    })
  })

  const settle = useCallback(payload => {
    setStreaming(false)
    setLiveChunks(null)
    void loadTranscript()
    optionsRef.current.onSettled?.(payload)
  }, [loadTranscript])

  usePluginEvent(events.done, payload => {
    if (optionsRef.current.keyOf(payload) === activeKeyRef.current) settle(payload)
  })
  usePluginEvent(events.error, payload => {
    if (optionsRef.current.keyOf(payload) === activeKeyRef.current) settle(payload)
  })

  const send = useCallback(async (content, attachments) => {
    const key = activeKeyRef.current
    if (!key) return
    setSendError(null)
    const row = optionsRef.current.optimisticRow
      ? optionsRef.current.optimisticRow(content, attachments)
      : { kind: 'user', ts: new Date().toISOString(), content }
    setMessages(prev => [...prev, row])
    setStreaming(true)
    setLiveChunks([])
    const res = await optionsRef.current.post(key, content, attachments)
    if (!res.ok && activeKeyRef.current === key) {
      setStreaming(false)
      setLiveChunks(null)
      setSendError(res.error ?? `send failed (${res.status ?? 'network'})`)
    }
  }, [])

  return { messages, meta, liveChunks, streaming, sendError, send, refresh: loadTranscript }
}

// ── Attention kit (#703) — pure rules + provider hook, mirroring the real
// kit (OS notification and chime are inert in tests). ──

export function visibleIdFromLocation(pathname, base, opts) {
  const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/?$`).exec(pathname)
  if (!match) return ''
  const id = decodeURIComponent(match[1])
  return opts?.exclude?.includes(id) ? '' : id
}

export function badgeFor(totalUnread, inflightCount) {
  if (totalUnread > 0) return { count: totalUnread, tone: 'attention' }
  if (inflightCount > 0) return { tone: 'info' }
  return null
}

export function useConversationAttention(config) {
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [inflight, setInflight] = useState(new Set())
  const configRef = useRef(config)
  configRef.current = config

  const refreshTotals = useCallback(async () => {
    try {
      const totals = await configRef.current.refreshTotals()
      if (!totals) return
      setUnreadTotal(totals.unreadTotal)
      setInflight(new Set(totals.inflightKeys))
    } catch { /* hiccups never break the shell */ }
  }, [])

  useEffect(() => { void refreshTotals() }, [refreshTotals])

  usePluginEvent(config.events.started ?? '__attention_noop_started', payload => {
    const key = configRef.current.keyOf(payload)
    setInflight(prev => (prev.has(key) ? prev : new Set(prev).add(key)))
  })

  usePluginEvent(config.events.chunk, payload => {
    const key = configRef.current.keyOf(payload)
    setInflight(prev => (prev.has(key) ? prev : new Set(prev).add(key)))
  })

  usePluginEvent(config.events.done, payload => {
    const cfg = configRef.current
    const key = cfg.keyOf(payload)
    setInflight(prev => { const next = new Set(prev); next.delete(key); return next })
    const viewing = cfg.visibleKey() === key
    const settings = cfg.settings?.() ?? { sound: true, toasts: true }
    if (!payload.aborted && !viewing && settings.toasts) {
      const node = cfg.renderToast(
        { key, agentId: String(payload.agentId ?? ''), preview: payload.preview, aborted: payload.aborted },
        () => {},
      )
      toast(node, 'info')
    }
    if (!payload.aborted && !viewing && settings.sound) cfg.chime?.()
    void refreshTotals()
  })

  usePluginEvent(config.events.error, payload => {
    const cfg = configRef.current
    const key = cfg.keyOf(payload)
    setInflight(prev => { const next = new Set(prev); next.delete(key); return next })
    const settings = cfg.settings?.() ?? { sound: true, toasts: true }
    if (cfg.visibleKey() !== key && settings.toasts) {
      const message = cfg.errorToast?.(payload)
      if (message) toast(message, 'error')
    }
    void refreshTotals()
  })

  const refreshEvents = config.events.refresh ?? []
  usePluginEvent(refreshEvents[0] ?? `${config.pluginId}.__attention_noop_0`, () => { void refreshTotals() })
  usePluginEvent(refreshEvents[1] ?? `${config.pluginId}.__attention_noop_1`, () => { void refreshTotals() })

  useNavBadge(config.pluginId, config.navItemId, badgeFor(unreadTotal, inflight.size))
}
