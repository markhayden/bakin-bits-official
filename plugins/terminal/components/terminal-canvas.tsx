import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button } from '@makinbakin/sdk/ui'
import { LocateFixed, ZoomOut } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { clampSize } from '../lib/sizing'
import { clientId } from './api'
import { enableWebgl } from './terminal-renderer'
import { TerminalSocketClient, type InputResult } from './terminal-socket'
import { consumeControl, encodeTerminalKey, type TerminalInputHandle } from './terminal-input'
import { BASE_FONT, clampFont, fitWidthFont, minFont, pinchFont, resizePlan, reveal, screenDevice, storedFont, storeFont } from './terminal-view'
import '@xterm/xterm/css/xterm.css'

/** What the page asks of the canvas: "Fit to this device" claims the size; refit applies a new smallest-text choice. */
export interface TerminalViewHandle { fitToDevice(): boolean; refit(): void }

export function TerminalCanvas({ session, writable, captureTab, attempt, inputEnabled, inputHandle, viewHandle, onCtrlChange, onStatus, onInput, onClaim, onSession, onSizeFrozen, onResult }: {
  inputEnabled: boolean; inputHandle: RefObject<TerminalInputHandle | null>; viewHandle: RefObject<TerminalViewHandle | null>; onCtrlChange(armed: boolean): void;
  session: Session; writable: boolean; captureTab: boolean; attempt: number; onStatus(status: string): void; onInput(data: string): void; onClaim(data: string): void; onSession(session: Session): void; onSizeFrozen(frozen: boolean): void; onResult(result: InputResult): void
}) {
  const pane = useRef<HTMLDivElement>(null)
  const element = useRef<HTMLDivElement>(null)
  // This screen sizes the grid only while it holds the session's size claim;
  // every other screen renders the real grid at a font fitted to its width.
  const authority = session.state === 'running' && session.sizeAuthority?.viewer === clientId()
  // A pinched font for this device (remembered), overriding the fit until "Reset view".
  const [zoom, setZoom] = useState(() => storedFont())
  // Manual pans, selections (and History) stop the view chasing the cursor.
  const [paused, setPaused] = useState(false)
  const callbacks = useRef({ onInput, onClaim, onSession, onSizeFrozen, onResult, writable, authority, inputEnabled, onCtrlChange, captureTab: false, sizeEpoch: session.sizeEpoch, zoom, paused })
  callbacks.current = { onInput, onClaim, onSession, onSizeFrozen, onResult, writable, authority, inputEnabled, onCtrlChange, captureTab, sizeEpoch: session.sizeEpoch, zoom, paused }
  const [status, setStatus] = useState('Connecting')
  useEffect(() => { onStatus(status) }, [status, onStatus])
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const socket = useRef<TerminalSocketClient | null>(null)
  const sentSize = useRef('')
  const ctrl = useRef(false)
  const ready = useRef(false)
  // Re-plan the sizing screen's grid (pane changes and acknowledged sizes both ask).
  const replan = useRef<() => void>(() => {})

  function screen(): HTMLElement | null { return element.current?.querySelector('.xterm-screen') ?? null }
  function paneBox(): { width: number; height: number } | undefined {
    const el = pane.current
    if (!el) return undefined
    const style = getComputedStyle(el)
    const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const height = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  function setFont(size: number): boolean {
    const term = terminal.current
    if (!term || term.options.fontSize === size) return false
    term.options.fontSize = size
    // The font this device renders at, for its renderer-independent observers (tests).
    pane.current?.setAttribute('data-font-size', String(size))
    return true
  }
  // Not the authority: keep the grid, fit the font to the pane's width.
  // Cells snap to device pixels, so width is not linear in the font: estimate,
  // render, and narrow between the largest font known to fit and the smallest
  // known to overflow, one animation frame per try.
  function fitFontToWidth(passes = 8, known = { fits: 0, overflows: Infinity }): void {
    const term = terminal.current
    const box = paneBox()
    const rendered = screen()
    if (!term || !box || !rendered?.clientWidth || callbacks.current.authority || callbacks.current.zoom !== undefined) return
    const current = term.options.fontSize ?? BASE_FONT
    const min = minFont()
    const fits = rendered.clientWidth <= box.width
    // A font below this device's minimum is never a candidate, even one that fits.
    if (fits && current >= min) known.fits = Math.max(known.fits, current)
    if (!fits) known.overflows = Math.min(known.overflows, current)
    const estimate = fitWidthFont(current, box.width, rendered.clientWidth, min)
    const next = Math.max(min, known.fits, Math.min(estimate, known.overflows - 1))
    if (next === current || passes === 0) {
      // Out of tries on an overflowing size: settle on the best that fit (else the minimum, which pans).
      if (!fits) setFont(Math.max(min, known.fits))
      return
    }
    setFont(next)
    requestAnimationFrame(() => fitFontToWidth(passes - 1, known))
  }
  /** The grid this pane holds at the current font, within the 40×10 floor. */
  function proposedSize(): { cols: number; rows: number } | undefined {
    const size = fit.current?.proposeDimensions()
    return size ? clampSize(size.cols, size.rows) : undefined
  }
  function sendSize(cols: number, rows: number) {
    const term = terminal.current
    if (!term || !callbacks.current.authority) return
    // Never resend a size within one claim; the session update the server pushes resizes xterm.
    const key = `${callbacks.current.sizeEpoch} ${cols}x${rows}`
    if ((term.cols === cols && term.rows === rows) || sentSize.current === key) return
    // Only a size that actually left counts; a disconnected one is retried after the next sync.
    if (socket.current?.resize(callbacks.current.sizeEpoch, cols, rows)) sentSize.current = key
  }
  function resizeToViewport() {
    const size = proposedSize()
    if (size) sendSize(size.cols, size.rows)
  }
  /** Render this device's view: the authority fits the grid to its pane; anyone else fits the font. */
  function applyView() {
    if (callbacks.current.authority) {
      setFont(callbacks.current.zoom ?? BASE_FONT)
      // Cell metrics follow the font on the next frame.
      requestAnimationFrame(resizeToViewport)
    } else if (callbacks.current.zoom !== undefined) setFont(callbacks.current.zoom)
    else fitFontToWidth()
  }
  /** Scroll the pane the least distance that shows the cursor cell. */
  function followCursor() {
    const term = terminal.current
    const el = pane.current
    const rendered = screen()
    if (!term || !el || !rendered?.clientWidth || callbacks.current.paused) return
    const buffer = term.buffer.active
    // Someone scrolled xterm's own history: the cursor is not on screen.
    if (buffer.viewportY !== buffer.baseY) return
    const cell = { width: rendered.clientWidth / term.cols, height: rendered.clientHeight / term.rows }
    const origin = rendered.getBoundingClientRect()
    const view = el.getBoundingClientRect()
    const target = {
      left: origin.left - view.left + el.scrollLeft + buffer.cursorX * cell.width,
      top: origin.top - view.top + el.scrollTop + buffer.cursorY * cell.height,
      width: cell.width, height: cell.height,
    }
    const next = reveal(el, target, cell.height)
    if (next.left !== el.scrollLeft || next.top !== el.scrollTop) el.scrollTo(next.left, next.top)
  }
  function overflows(): boolean {
    const el = pane.current
    return Boolean(el && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight))
  }
  /** A pan (only meaningful when the pane overflows) or a selection (always) stops the view chasing the cursor. */
  function pause(always = false) {
    if (callbacks.current.paused || (!always && !overflows())) return
    callbacks.current.paused = true
    setPaused(true)
  }
  function zoomTo(size: number | undefined) {
    callbacks.current.zoom = size
    setZoom(size)
    storeFont(size)
  }

  useEffect(() => {
    ready.current = false
    const setCtrl = (armed: boolean) => { ctrl.current = armed; callbacks.current.onCtrlChange(armed) }
    const reset = () => setCtrl(false)
    reset()
    const background = getComputedStyle(pane.current!).backgroundColor
    const term = new Terminal({ cols: session.cols, rows: session.rows, scrollback: 2000, fontSize: callbacks.current.zoom ?? BASE_FONT, screenReaderMode: true, convertEol: false, theme: { background } })
    terminal.current = term
    pane.current!.setAttribute('data-font-size', String(term.options.fontSize))
    fit.current = new FitAddon()
    term.loadAddon(fit.current)
    term.open(element.current!)
    const disposeRenderer = enableWebgl(term)
    inputHandle.current = {
      key(key) {
        if (!ready.current || !callbacks.current.inputEnabled) { reset(); return }
        const data = encodeTerminalKey(key, term.modes.applicationCursorKeysMode, ctrl.current)
        reset()
        term.input(data, true)
      },
      toggleCtrl() { if (ready.current && callbacks.current.inputEnabled) setCtrl(!ctrl.current) },
      reset,
      send: (generation, data) => socket.current?.input(generation, data) ?? false,
    }
    viewHandle.current = {
      fitToDevice() {
        const box = paneBox()
        const rendered = screen()
        if (!box || !rendered?.clientWidth) return false
        // Measure at the font this screen will size at; it refines the grid
        // itself once the pushed session names it the authority.
        const scale = (callbacks.current.zoom ?? BASE_FONT) / (term.options.fontSize ?? BASE_FONT)
        const cell = { width: (rendered.clientWidth / term.cols) * scale, height: (rendered.clientHeight / term.rows) * scale }
        const { cols, rows } = clampSize(Math.floor(box.width / cell.width), Math.floor(box.height / cell.height))
        return socket.current?.claim(cols, rows, screenDevice()) ?? false
      },
      refit: () => applyView(),
    }
    const leave = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.terminal-xterm, .terminal-input-controls')) reset()
    }
    const hide = () => { if (document.hidden) reset() }
    const textarea = term.textarea!
    textarea.addEventListener('paste', reset, true)
    textarea.addEventListener('compositionstart', reset, true)
    document.addEventListener('focusin', leave)
    document.addEventListener('pointerdown', leave)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('blur', reset)
    term.attachCustomKeyEventHandler((event) => event.key !== 'Tab' || (callbacks.current.inputEnabled && callbacks.current.captureTab))
    // Watching + typing claims the session (claim-on-type); the page decides
    // whether to confirm. Drop control keys so a stray Ctrl-key can't claim.
    term.onData((data) => {
      if (callbacks.current.writable) {
        if (!ready.current || !callbacks.current.inputEnabled) { reset(); return }
        const next = consumeControl(data, ctrl.current)
        reset()
        callbacks.current.onInput(next.data)
      }
      else if (data && data.charCodeAt(0) >= 0x20) callbacks.current.onClaim(data)
    })
    // Follow the cursor once per rendered batch, unless the operator panned away.
    let follow = 0
    term.onRender(() => { if (!follow) follow = requestAnimationFrame(() => { follow = 0; followCursor() }) })
    term.onSelectionChange(() => { if (term.hasSelection()) pause(true) })
    const url = new URL(`/api/plugins/terminal/socket?id=${encodeURIComponent(session.id)}`, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const client = new TerminalSocketClient({
      url: url.href, clientId: clientId(),
      onSync: (sync) => {
        // A sync is a complete picture: the snapshot, then output after its cursor.
        term.reset()
        if (sync.snapshot) term.write(Uint8Array.from(atob(sync.snapshot), (value) => value.charCodeAt(0)))
        callbacks.current.onSession(sync.session)
        ready.current = sync.session.state !== 'completed'
        // Every sync re-fits: the server may hold any size by now.
        sentSize.current = ''
        requestAnimationFrame(applyView)
      },
      onOutput: (bytes, done) => term.write(bytes, done),
      onSession: (next) => callbacks.current.onSession(next),
      onPresence: (frozen) => callbacks.current.onSizeFrozen(frozen),
      onResult: (result) => callbacks.current.onResult(result),
      onStatus: (next) => {
        if (next !== 'Connected') { ready.current = false; reset() }
        setStatus(next)
      },
    })
    socket.current = client
    client.connect()
    // Phones suspend backgrounded pages and may leave a socket that looks open
    // but is dead: after a real absence (or a network change) take a fresh
    // connection and sync; otherwise just run any pending reconnect now.
    let hiddenAt = 0
    const visibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return }
      if (hiddenAt && Date.now() - hiddenAt > 5000) client.reconnect()
      else client.resume()
      hiddenAt = 0
    }
    const online = () => client.reconnect()
    const resume = () => client.resume()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', online)
    window.addEventListener('focus', resume)
    return () => {
      ready.current = false
      inputHandle.current = null
      viewHandle.current = null
      cancelAnimationFrame(follow)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', online)
      window.removeEventListener('focus', resume)
      client.close(); socket.current = null; sentSize.current = ''
      textarea.removeEventListener('paste', reset, true)
      textarea.removeEventListener('compositionstart', reset, true)
      document.removeEventListener('focusin', leave)
      document.removeEventListener('pointerdown', leave)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('blur', reset)
      disposeRenderer(); term.dispose(); terminal.current = null
    }
  }, [session.id, attempt])
  useLayoutEffect(() => { inputHandle.current?.reset() }, [inputEnabled, session.generation, session.id, attempt])
  // A new grid: other screens refit their font to it; the authority re-plans
  // against its pane (which may have moved again before this answer came).
  useEffect(() => {
    terminal.current?.resize(session.cols, session.rows)
    if (callbacks.current.authority) replan.current()
    else requestAnimationFrame(applyView)
  }, [session.cols, session.rows])
  useEffect(() => { applyView() }, [authority, zoom])
  // A new claim (by anyone) starts a fresh exchange: what this screen sent before is no longer known to the server.
  useEffect(() => { sentSize.current = '' }, [authority, session.sizeEpoch])

  // Pinch (two fingers, or Ctrl+wheel on a trackpad) sets this device's font;
  // one-finger drags, wheels and scrollbar or arrow-key scrolling pan natively
  // and pause cursor-follow. None of it focuses the keyboard or sends input:
  // wheels are taken in the capture phase, before xterm can turn them into
  // scrollback scrolling or (in full-screen programs) arrow keys.
  useEffect(() => {
    const el = pane.current
    if (!el) return
    let pinch: { distance: number; font: number; next?: number } | undefined
    let frame = 0
    let commit: ReturnType<typeof setTimeout> | undefined
    const distance = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)
    const preview = (size: number) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setFont(size))
    }
    const start = (event: TouchEvent) => {
      if (event.touches.length === 2) pinch = { distance: distance(event.touches), font: terminal.current?.options.fontSize ?? BASE_FONT }
    }
    const move = (event: TouchEvent) => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault()
        pinch.next = pinchFont(pinch.font, pinch.distance, distance(event.touches), minFont())
        preview(pinch.next)
      } else if (event.touches.length === 1) pause()
    }
    const end = (event: TouchEvent) => {
      if (!pinch || event.touches.length >= 2) return
      // The last move may still be waiting for its frame: commit what it asked for.
      const size = pinch.next
      pinch = undefined
      cancelAnimationFrame(frame)
      if (size === undefined) return
      setFont(size)
      zoomTo(size)
    }
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        // A pane that overflows pans; one that fits leaves the wheel to the terminal.
        // The pane scrolls itself: left alone, the browser would scroll xterm's
        // own history viewport under the pointer instead.
        if (!overflows()) return
        event.preventDefault()
        event.stopPropagation()
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1
        el.scrollBy(event.deltaX * unit, event.deltaY * unit)
        pause()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const size = clampFont((terminal.current?.options.fontSize ?? BASE_FONT) * (1 - event.deltaY / 100), minFont())
      setFont(size)
      clearTimeout(commit)
      commit = setTimeout(() => zoomTo(size), 150)
    }
    const key = (event: KeyboardEvent) => { if (event.target === el && /^(Arrow|Page|Home|End)/.test(event.key)) pause() }
    // Pressing the pane itself (not the terminal) is a scrollbar drag.
    const press = (event: PointerEvent) => { if (event.target === el) pause() }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    el.addEventListener('wheel', wheel, { passive: false, capture: true })
    el.addEventListener('keydown', key)
    el.addEventListener('pointerdown', press)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(commit)
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      el.removeEventListener('wheel', wheel, { capture: true })
      el.removeEventListener('keydown', key)
      el.removeEventListener('pointerdown', press)
    }
  }, [session.id, attempt])

  useEffect(() => {
    if (!pane.current) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    // The authority applies a height change at once (a phone keyboard
    // opening), at the current width, and debounces width changes (a window
    // drag) by 100 ms. Other screens refit their font after 100 ms.
    const schedule = () => {
      if (disposed) return
      clearTimeout(timer)
      const term = terminal.current
      const proposed = callbacks.current.authority ? proposedSize() : undefined
      if (!term || !proposed) { timer = setTimeout(applyView, 100); return }
      const plan = resizePlan(proposed, term)
      if (plan.now) sendSize(plan.now.cols, plan.now.rows)
      if (plan.later) timer = setTimeout(applyView, 100)
    }
    replan.current = schedule
    // Observe the pane, not the terminal's cell grid: resizing rows must not
    // create a feedback loop, and other viewers must never resize the session.
    const observer = new ResizeObserver(schedule)
    observer.observe(pane.current)
    void document.fonts.ready.then(schedule)
    schedule()
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); replan.current = () => {} }
  }, [session.id, authority, session.sizeEpoch, attempt])

  function resumeFollow() {
    callbacks.current.paused = false
    setPaused(false)
    followCursor()
  }
  return <div className="terminal-view relative flex min-h-0 flex-1 flex-col">
    <div ref={pane} role="region" aria-label="Terminal output" tabIndex={0} data-fit={authority ? 'pane' : 'width'} className="terminal-pane min-h-0 flex-1 bg-bakin-canvas-default p-bakin-4">
      <div ref={element} className="terminal-xterm" />
    </div>
    {(paused || zoom !== undefined) && <div className="terminal-view-actions">
      {paused && <Button size="sm" variant="secondary" onClick={resumeFollow}><LocateFixed size={16} />Follow cursor</Button>}
      {zoom !== undefined && <Button size="sm" variant="secondary" onClick={() => zoomTo(undefined)}><ZoomOut size={16} />Reset view</Button>}
    </div>}
  </div>
}
