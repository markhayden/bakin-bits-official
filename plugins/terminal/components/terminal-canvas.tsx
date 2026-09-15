import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { BoundedOverflow } from '@makinbakin/sdk/layout'
import type { Session } from '../lib/contracts'
import { terminalFetch } from './api'
import '@xterm/xterm/css/xterm.css'

export function TerminalCanvas({ session, writable, captureTab, attempt, onStatus, onInput, onClaim, onSession, onResize }: {
  session: Session; writable: boolean; captureTab: boolean; attempt: number; onStatus(status: string): void; onInput(data: string): void; onClaim(data: string): void; onSession(session: Session): void; onResize(cols: number, rows: number): Promise<boolean | undefined>
}) {
  const element = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onInput, onClaim, onSession, onResize, writable, captureTab: false })
  callbacks.current = { onInput, onClaim, onSession, onResize, writable, captureTab }
  const [status, setStatus] = useState('Connecting')
  const [truncated, setTruncated] = useState(false)
  useEffect(() => { onStatus(`${status}${truncated ? ' / Earlier output truncated' : ''}`) }, [status, truncated, onStatus])
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const resizing = useRef(false)
  const resizeAgain = useRef(false)
  const BASE_FONT = 13
  // Watching a session we don't own: we must not resize the shared PTY, so
  // instead scale the font up/down so the agent's fixed grid fills the pane.
  // Purely local; converges over a few animation frames as xterm re-renders.
  function fitFontToPane(passes = 3): void {
    const term = terminal.current
    const el = element.current
    if (!term || !el || callbacks.current.writable) return
    const screen = el.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen || !screen.clientWidth || !screen.clientHeight || !el.clientWidth || !el.clientHeight) return
    const current = term.options.fontSize ?? BASE_FONT
    const ratio = Math.min(el.clientWidth / screen.clientWidth, el.clientHeight / screen.clientHeight)
    const next = Math.max(8, Math.min(28, Math.floor(current * ratio)))
    if (next === current) return
    term.options.fontSize = next
    if (passes > 0) requestAnimationFrame(() => fitFontToPane(passes - 1))
  }
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
    // Watching + typing claims the session (claim-on-type); the page decides
    // whether to confirm. Drop control keys so a stray Ctrl-key can't claim.
    term.onData((data) => {
      if (callbacks.current.writable) callbacks.current.onInput(data)
      else if (data && data.charCodeAt(0) >= 0x20) callbacks.current.onClaim(data)
    })
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
  useEffect(() => { terminal.current?.resize(session.cols, session.rows); fitFontToPane() }, [session.cols, session.rows])
  useEffect(() => {
    if (!element.current) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      if (disposed) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Driving: fit the PTY to the pane at the base font. Watching: keep the
        // PTY and scale the font so the fixed grid fills the pane instead.
        if (callbacks.current.writable) {
          if (terminal.current && terminal.current.options.fontSize !== BASE_FONT) terminal.current.options.fontSize = BASE_FONT
          void resizeToViewport()
        } else fitFontToPane()
      }, 100)
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
