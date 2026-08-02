'use client'

import { useCallback, useRef, useState } from 'react'
import type { ConversationChunk } from '@makinbakin/sdk/conversation'

interface ConversationStreamOptions {
  fetcher: (content: string, context: { signal: AbortSignal }) => Promise<Response>
  onCustom?: (event: string, data: unknown) => void
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

interface ConversationSseHandlers {
  signal: AbortSignal
  onChunk: (chunk: ConversationChunk) => void
  onCustom?: (event: string, data: unknown) => void
}

interface SseFrame {
  event: string
  data: unknown
}

const CHUNK_TYPES = new Set(['text', 'tool', 'status', 'done', 'error'])

function isRuntimeChunk(data: unknown): data is ConversationChunk {
  return Boolean(
    data &&
      typeof data === 'object' &&
      typeof (data as { type?: unknown }).type === 'string' &&
      CHUNK_TYPES.has((data as { type: string }).type),
  )
}

function textField(data: unknown, key: string): string {
  if (!data || typeof data !== 'object') return ''
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function parseSseFrame(frame: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
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

function drainSseFrames(input: string, flush = false): { frames: SseFrame[]; remainder: string } {
  const parts = input.split(/\r?\n\r?\n/)
  const remainder = flush ? '' : parts.pop() ?? ''
  const frames = parts.map(parseSseFrame).filter((frame): frame is SseFrame => frame !== null)

  if (flush && parts.length === 0 && input.trim()) {
    const frame = parseSseFrame(input)
    if (frame) frames.push(frame)
  }

  return { frames, remainder }
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

async function readConversationSseStream(
  response: Response,
  handlers: ConversationSseHandlers,
): Promise<{ content: string }> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Server returned ${response.status}`)
  }

  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  handlers.signal.addEventListener('abort', abort, { once: true })

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let finalContent = ''

  const dispatch = (frame: SseFrame) => {
    if (frame.event === 'chunk') {
      if (!isRuntimeChunk(frame.data)) return
      if (frame.data.type === 'text') accumulated += frame.data.content ?? ''
      handlers.onChunk(frame.data)
      return
    }
    if (frame.event === 'done') {
      finalContent = textField(frame.data, 'content') || accumulated
      return
    }
    if (frame.event === 'error') {
      throw new Error(textField(frame.data, 'message') || 'Unknown error')
    }
    handlers.onCustom?.(frame.event, frame.data)
  }

  try {
    while (true) {
      if (handlers.signal.aborted) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = drainSseFrames(buffer)
      buffer = parsed.remainder
      for (const frame of parsed.frames) dispatch(frame)
    }

    buffer += decoder.decode()
    const parsed = drainSseFrames(buffer, true)
    for (const frame of parsed.frames) dispatch(frame)
  } finally {
    handlers.signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }

  return { content: finalContent || accumulated }
}

/**
 * Compatibility transport for Messaging's existing per-request SSE routes.
 * Remove this when Plans and Brainstorm move to the durable conversation bus.
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
    setStreaming(true)
    setLiveChunks([])
    const chunks: ConversationChunk[] = []

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
