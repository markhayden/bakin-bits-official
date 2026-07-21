import { useCallback, useEffect, useRef, useState } from 'react'
import { setNavBadge } from './index.js'

const defaultAgents = [
  { id: 'basil', name: 'Basil' },
  { id: 'scout', name: 'Scout' },
  { id: 'nemo', name: 'Nemo' },
  { id: 'zen', name: 'Zen' },
  { id: 'main', name: 'Main' },
]

function hookOverride(name) {
  return globalThis.__bakinTestSdkHooks?.[name]
}

export function useRouter() {
  const override = hookOverride('useRouter')
  if (override) return override()
  return {
    push: () => {},
    replace: () => {},
    back: () => {},
  }
}

export function usePathname() {
  const override = hookOverride('usePathname')
  if (override) return override()
  return '/'
}

export function useSearchParams() {
  const override = hookOverride('useSearchParams')
  if (override) return override()
  return new URLSearchParams()
}

export function useQueryState(key, defaultValue = '') {
  const override = hookOverride('useQueryState')
  if (override) return override(key, defaultValue)
  const [value, setValue] = useState(defaultValue)
  return [value, setValue, setValue]
}

export function useQueryArrayState(key) {
  const override = hookOverride('useQueryArrayState')
  if (override) return override(key)
  return useState([])
}

export function useSearch(config) {
  const override = hookOverride('useSearch')
  if (override) return override(config)
  return {
    results: [],
    aggregations: {},
    loading: false,
    error: null,
    meta: null,
    search: () => {},
    clear: () => {},
  }
}

export function reorderBySearchResults(items) {
  const override = hookOverride('reorderBySearchResults')
  if (override) return override(items)
  return items
}

export function useDebug() {
  const override = hookOverride('useDebug')
  if (override) return override()
  return [false]
}

export function useAgent(agentId) {
  const override = hookOverride('useAgent')
  if (override) return override(agentId)
  return defaultAgents.find(agent => agent.id === agentId) ?? (agentId ? { id: agentId, name: agentId } : null)
}

export function useAgentList() {
  const override = hookOverride('useAgentList')
  if (override) return override()
  return defaultAgents
}

export function useAgentIds() {
  const override = hookOverride('useAgentIds')
  if (override) return override()
  return defaultAgents.map(agent => agent.id)
}

export function useMainAgentId() {
  const override = hookOverride('useMainAgentId')
  if (override) return override()
  return 'main'
}

export function useAgentColor() {
  const override = hookOverride('useAgentColor')
  if (override) return override()
  return '#888888'
}

export function useAgentDisplayName(agentId) {
  const override = hookOverride('useAgentDisplayName')
  if (override) return override(agentId)
  return useAgent(agentId)?.name ?? agentId
}

export function usePackageState() {
  const override = hookOverride('usePackageState')
  if (override) return override()
  return null
}

export function hexToMuted(hex) {
  return hex
}

export function useNotificationChannels() {
  const override = hookOverride('useNotificationChannels')
  if (override) return override()
  return [
    { id: 'general', label: 'General', initials: 'GE' },
    { id: 'email', label: 'Email', initials: 'EM' },
    { id: 'alerts', label: 'Alerts', initials: 'AL' },
    { id: 'discord', label: 'Discord', initials: 'DI' },
  ]
}

export function getChannelLabel(channelId, channels = useNotificationChannels()) {
  return channels.find(channel => channel.id === channelId)?.label ?? channelId
}

export function getChannelInitials(channelId, channels = useNotificationChannels()) {
  return channels.find(channel => channel.id === channelId)?.initials ?? channelId.slice(0, 2).toUpperCase()
}

export function toast(...args) {
  const override = hookOverride('toast')
  if (override) return override(...args)
}
export function useToastStore() {
  const override = hookOverride('useToastStore')
  if (override) return override()
  return {}
}

export function useHorizontalResize({ defaultWidth, minWidth, maxWidth }) {
  const clamp = (n) => Math.min(maxWidth, Math.max(minWidth, n))
  const [width, setWidthState] = useState(() => clamp(defaultWidth))
  const widthRef = useRef(width)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const setWidth = useCallback((w) => {
    const next = clamp(w)
    widthRef.current = next
    setWidthState(next)
  }, [minWidth, maxWidth])

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = widthRef.current
    const move = (ev) => {
      if (!dragging.current) return
      const next = clamp(startWidth.current + startX.current - ev.clientX)
      widthRef.current = next
      setWidthState(next)
    }
    const up = () => {
      dragging.current = false
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [minWidth, maxWidth])

  const onTouchStart = useCallback((e) => {
    const touch = e.touches[0]
    if (!touch) return
    dragging.current = true
    startX.current = touch.clientX
    startWidth.current = widthRef.current
    const move = (ev) => {
      const t = ev.touches[0]
      if (!t || !dragging.current) return
      ev.preventDefault()
      const next = clamp(startWidth.current + startX.current - t.clientX)
      widthRef.current = next
      setWidthState(next)
    }
    const up = () => {
      dragging.current = false
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', up)
      document.removeEventListener('touchcancel', up)
    }
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', up)
    document.addEventListener('touchcancel', up)
  }, [minWidth, maxWidth])

  const onKeyDown = useCallback((e) => {
    let dir = 0
    if (e.key === 'ArrowLeft') dir = 1
    else if (e.key === 'ArrowRight') dir = -1
    else return
    e.preventDefault()
    const step = e.shiftKey ? 64 : 16
    setWidth(widthRef.current + dir * step)
  }, [setWidth])

  return {
    width,
    setWidth,
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': minWidth,
      'aria-valuemax': maxWidth,
      onMouseDown,
      onTouchStart,
      onKeyDown,
    },
  }
}

export function useNavBadge(pluginId, navItemId, badge) {
  const override = hookOverride('useNavBadge')
  if (override) return override(pluginId, navItemId, badge)
  const key = badge ? `${badge.count ?? ''}:${badge.tone ?? ''}` : 'null'
  useEffect(() => {
    setNavBadge(pluginId, navItemId, badge)
  }, [pluginId, navItemId, key])
}


// ── Plugin-event bus (#703) — mirrors the shell's process-global emitter ──

const pluginEventSubs = globalThis.__bakinPluginEventSubs ?? (globalThis.__bakinPluginEventSubs = new Map())

export function emitPluginEvent(payload) {
  const event = payload?.event
  if (typeof event !== 'string') return
  const set = pluginEventSubs.get(event)
  if (!set) return
  for (const handler of [...set]) {
    try { handler(payload) } catch { /* a bad subscriber never breaks the bus */ }
  }
}

export function usePluginEvent(event, handler) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    const wrapped = payload => handlerRef.current(payload)
    let set = pluginEventSubs.get(event)
    if (!set) {
      set = new Set()
      pluginEventSubs.set(event, set)
    }
    set.add(wrapped)
    return () => {
      set.delete(wrapped)
      if (set.size === 0) pluginEventSubs.delete(event)
    }
  }, [event])
}
