import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button, Checkbox } from '@makinbakin/sdk/ui'
import { RotateCw, Maximize } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { terminalFetch } from './api'
import '@xterm/xterm/css/xterm.css'

export function TerminalCanvas({ session, writable, onInput, onSession, onResize }: {
  session: Session; writable: boolean; onInput(data: string): void; onSession(session: Session): void; onResize(cols: number, rows: number): void
}) {
  const element = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onInput, onSession, onResize, writable, captureTab: false })
  const [captureTab, setCaptureTab] = useState(false)
  callbacks.current = { onInput, onSession, onResize, writable, captureTab }
  const [status, setStatus] = useState('Connecting')
  const [attempt, setAttempt] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  function resizeToViewport() {
    const size = fit.current?.proposeDimensions()
    if (size && callbacks.current.writable) callbacks.current.onResize(Math.min(400, Math.max(20, size.cols)), Math.min(150, Math.max(5, size.rows)))
  }
  useEffect(() => {
    const abort = new AbortController()
    const term = new Terminal({ cols: session.cols, rows: session.rows, scrollback: 2000, fontSize: 13, screenReaderMode: true, convertEol: false })
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
  return <div className="terminal-display">
    <div className="terminal-display-status">
      <span role="status">{status}{truncated ? ' / Earlier output truncated' : ''}</span>
      <label className="terminal-tab-toggle"><Checkbox checked={captureTab} onCheckedChange={(checked: boolean) => setCaptureTab(checked)} />Capture Tab</label>
      <Button size="icon-sm" variant="ghost" aria-label="Fit terminal to viewport" title="Fit terminal to viewport" disabled={!writable} onClick={resizeToViewport}><Maximize size={16} /></Button>
      <Button size="icon-sm" variant="ghost" aria-label="Reconnect terminal" title="Reconnect terminal" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={16} /></Button>
    </div>
    <div className="terminal-scroll" aria-label="Terminal output">
      <div ref={element} className="terminal-xterm" />
    </div>
  </div>
}
