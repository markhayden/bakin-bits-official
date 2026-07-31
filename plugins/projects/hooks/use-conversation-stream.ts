'use client'

import { useCallback, useRef, useState } from 'react'
import type { ConversationChunk } from '@makinbakin/sdk/conversation'

interface ConversationStreamOptions {
  fetcher: (content: string, context: { signal: AbortSignal }) => Promise<Response>
  onDone?: (finalContent: string) => void | Promise<void>
  onError?: (message: string) => void
  onAborted?: () => void
}

interface ConversationStream {
  liveChunks: ConversationChunk[] | null
  streaming: boolean
  send: (content: string) => Promise<void>
  abort: () => void
}

interface SseFrame {
  event: string
  data: unknown
}

function parseFrame(frame: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) return null
  const rawData = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(rawData) }
  } catch {
    return { event, data: rawData }
  }
}

function drainFrames(input: string, flush = false): { frames: SseFrame[]; remainder: string } {
  const parts = input.split(/\r?\n\r?\n/)
  const remainder = flush ? '' : parts.pop() ?? ''
  const frames = parts.map(parseFrame).filter((frame): frame is SseFrame => frame !== null)

  if (flush && parts.length === 0 && input.trim()) {
    const frame = parseFrame(input)
    if (frame) frames.push(frame)
  }

  return { frames, remainder }
}

function objectString(data: unknown, key: string): string {
  if (!data || typeof data !== 'object') return ''
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

async function readStream(
  response: Response,
  signal: AbortSignal,
  onChunk: (chunk: ConversationChunk) => void,
): Promise<string> {
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Server returned ${response.status}`)
  }

  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let finalContent = ''

  const dispatch = (frame: SseFrame) => {
    if (frame.event === 'chunk' && frame.data && typeof frame.data === 'object') {
      const chunk = frame.data as ConversationChunk
      if (chunk.type === 'text') accumulated += chunk.content ?? ''
      onChunk(chunk)
    } else if (frame.event === 'done') {
      finalContent = objectString(frame.data, 'content') || accumulated
    } else if (frame.event === 'error') {
      throw new Error(objectString(frame.data, 'message') || 'Unknown error')
    }
  }

  try {
    while (true) {
      if (signal.aborted) {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        throw error
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = drainFrames(buffer)
      buffer = parsed.remainder
      for (const frame of parsed.frames) dispatch(frame)
    }

    buffer += decoder.decode()
    for (const frame of drainFrames(buffer, true).frames) dispatch(frame)
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }

  return finalContent || accumulated
}

/**
 * Compatibility transport for Projects' existing per-request SSE route.
 * Remove this when project brainstorms move to the durable conversation bus.
 */
export function useConversationStream(options: ConversationStreamOptions): ConversationStream {
  const [liveChunks, setLiveChunks] = useState<ConversationChunk[] | null>(null)
  const [streaming, setStreaming] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const abort = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const send = useCallback(async (content: string) => {
    if (controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    const chunks: ConversationChunk[] = []
    setStreaming(true)
    setLiveChunks([])

    try {
      const response = await optionsRef.current.fetcher(content, { signal: controller.signal })
      const finalContent = await readStream(response, controller.signal, (chunk) => {
        chunks.push(chunk)
        setLiveChunks([...chunks])
      })
      setLiveChunks(null)
      await optionsRef.current.onDone?.(finalContent)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setLiveChunks(null)
        optionsRef.current.onAborted?.()
      } else {
        const message = error instanceof Error ? error.message : String(error)
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
