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

export { readBrainstormSseResponse } from './components.js'
