export function cn(...args) {
  return args.filter(Boolean).join(' ')
}

export function formatAge(value) {
  return String(value)
}

export function formatSize(bytes) {
  return `${bytes} B`
}

export function runtimeChunkToBrainstormActivity(chunk) {
  if (chunk.type === 'status') {
    return {
      kind: 'runtime_status',
      content: chunk.content || 'Agent status update',
      data: chunk.data,
    }
  }
  if (chunk.type === 'tool') {
    return {
      kind: 'tool_call',
      content: chunk.content || 'Tool call',
      data: chunk.data,
    }
  }
  if (chunk.type === 'error') {
    return {
      kind: 'error',
      content: chunk.content || 'Runtime stream error',
      data: chunk.data,
    }
  }
  return null
}

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

export { readBrainstormSseResponse } from './components.js'
