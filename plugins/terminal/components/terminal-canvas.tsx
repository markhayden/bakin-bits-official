import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { BoundedOverflow } from '@makinbakin/sdk/layout'
import type { Session } from '../lib/contracts'
import { terminalFetch } from './api'
import '@xterm/xterm/css/xterm.css'

export function TerminalCanvas({ session, writable, captureTab, attempt, onStatus, onInput, onSession, onResize }: {
  session: Session; writable: boolean; captureTab: boolean; attempt: number; onStatus(status: string): void; onInput(data: string): void; onSession(session: Session): void; onResize(cols: number, rows: number): Promise<boolean | undefined>
}) {
  const element = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onInput, onSession, onResize, writable, captureTab: false })
  callbacks.current = { onInput, onSession, onResize, writable, captureTab }
  const [status, setStatus] = useState('Connecting')
  const [truncated, setTruncated] = useState(false)
  useEffect(() => { onStatus(`${status}${truncated ? ' / Earlier output truncated' : ''}`) }, [status, truncated, onStatus])
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const resizing = useRef(false)
  const resizeAgain = useRef(false)
  async function resizeToViewport() {
    if (resizing.current) { resizeAgain.current = true; return }
    const term = terminal.current
    const size = fit.current?.proposeDimensions()
    if (!size || !term || !callbacks.current.writable) return
    const cols = Math.min(400, Math.max(20, size.cols))
    const rows = Math.min(150, Math.max(5, size.rows))
    if (term.cols === cols && term.rows === rows) return
    resizing.current = true
    try { await callbacks.current.onResize(cols, rows) }
    finally {
      resizing.current = false
      if (resizeAgain.current) { resizeAgain.current = false; void resizeToViewport() }
    }
  }
  useEffect(() => {
    const abort = new AbortController()
    const background = getComputedStyle(element.current!.parentElement!).backgroundColor
    const term = new Terminal({ cols: session.cols, rows: session.rows, scrollback: 2000, fontSize: 13, screenReaderMode: true, convertEol: false, theme: { background } })
    terminal.current = term
    fit.current = new FitAddon()
    term.loadAddon(fit.current)
    term.open(element.current!)
    term.attachCustomKeyEventHandler((event) => event.key !== 'Tab' || callbacks.current.captureTab)
    term.onData((data) => { if (callbacks.current.writable) callbacks.current.onInput(data) })
    async function connect() {
      setStatus('Connecting')
      try {
        const response = await terminalFetch(`/stream?id=${encodeURIComponent(session.id)}`, { signal: abort.signal })
        if (!response.ok || !response.body) throw new Error('Disconnected')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        try {
          while (!abort.signal.aborted) {
            const next = await reader.read()
            if (next.done) break
            pending += decoder.decode(next.value, { stream: true })
            if (pending.length > 4 * 1024 * 1024) throw new Error('Output frame too large')
            let boundary: number
            while ((boundary = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, boundary)
              pending = pending.slice(boundary + 2)
              if (!frame.startsWith('data: ')) continue
              const data = JSON.parse(frame.slice(6))
              if (data.type === 'error') throw new Error(data.error)
              if (data.type === 'snapshot') term.reset()
              if (data.session) callbacks.current.onSession(data.session)
              if (data.truncated) setTruncated(true)
              const bytes = Uint8Array.from(atob(data.data ?? ''), (value) => value.charCodeAt(0))
              await new Promise<void>((resolve) => term.write(bytes, resolve))
              setStatus(data.session?.state === 'completed' ? 'Completed' : 'Connected')
            }
          }
          if (!abort.signal.aborted) setStatus('Disconnected')
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch (error) { if (!abort.signal.aborted) setStatus(error instanceof Error ? error.message : 'Disconnected') }
    }
    void connect()
    return () => { abort.abort(); term.dispose(); terminal.current = null }
  }, [session.id, attempt])
  useEffect(() => { terminal.current?.resize(session.cols, session.rows) }, [session.cols, session.rows])
  useEffect(() => {
    if (!writable || !element.current) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      if (disposed) return
      clearTimeout(timer)
      timer = setTimeout(() => void resizeToViewport(), 100)
    }
    // Observe the pane, not the terminal's cell grid: resizing rows must not
    // create a feedback loop, and read-only viewers must never resize a PTY.
    const observer = new ResizeObserver(schedule)
    observer.observe(element.current)
    void document.fonts.ready.then(schedule)
    schedule()
    return () => { disposed = true; clearTimeout(timer); observer.disconnect() }
  }, [session.id, writable, attempt])
  return <BoundedOverflow label="Terminal output" className="min-h-[calc(var(--bakin-layout-space-8)*5)] flex-1 bg-bakin-canvas-default p-bakin-4">
      <div ref={element} className="terminal-xterm h-full min-w-0" />
    </BoundedOverflow>
}
