import { useState } from 'react'

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
