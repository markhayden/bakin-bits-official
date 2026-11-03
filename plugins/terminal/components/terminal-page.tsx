import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Page, PageBody, PageHeader, WorkspacePage, WorkspacePageHeader, WorkspacePageCompactHeader, WorkspacePageBody, ConfirmDialog, AgentAvatar, AgentSelect, CopyButton, DataTable, SegmentedControl } from '@makinbakin/sdk/patterns'
import { Inline, Panel, Stack } from '@makinbakin/sdk/layout'
import { Alert, AlertDescription, Badge, Banner, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SystemState, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Text, Separator, Popover, PopoverTrigger, PopoverContent, PopoverTitle, DropdownMenuItem, DropdownMenuSwitchItem, DropdownMenuSeparator } from '@makinbakin/sdk/ui'
import { PluginLink, useQueryState, useRouter } from '@makinbakin/sdk/navigation'
import { formatAge } from '@makinbakin/sdk/utils'
import { toast, useFullscreen } from '@makinbakin/sdk/hooks'
import { Plus, Hand, Play, Square, UserRoundCheck, CornerDownLeft, ArrowLeft, Info, Terminal, RotateCw, Keyboard, Ruler, AppWindow, ClipboardCopy, Expand, Shrink, MessageSquareText } from 'lucide-react'
import { attachCommand, shortId, type Session } from '../lib/contracts'
import type { SessionOptionsData } from '../lib/session-options'
import { unavailableNotice } from '../lib/unavailable-notice'
import type { UnavailableReason } from '../lib/socket'
import { api, clientId } from './api'
import { KeyBar } from './key-bar'
import { lineTail, useCoarsePointer, useEditingSession, useEnterHidesKeyboard } from './editing-session'
import { INPUT_LIMIT_BYTES, NO_MODIFIERS, type ModifierState, type TerminalInputHandle } from './terminal-input'
import { readDraft, writeDraft } from './compose-drafts'
import { ComposeSheet, type PasteOutcome } from './compose-sheet'
import { TerminalCanvas, type TerminalViewHandle } from './terminal-canvas'
import { CopyTextSheet } from './copy-text-sheet'
import { SizeControl } from './size-control'
import { estimateTerminalSize } from './terminal-size'
import type { InputResult, Presence } from './terminal-socket'
import { NewSession } from './new-session'
import { TerminalTool as Tool } from './terminal-tool'
import { useTerminalAgents } from './use-terminal-agents'
import { SessionActions, type SessionConfirmation } from './session-actions'
import { attentionChip, setWatching, wantsYou, WATCHING_BEAT_MS } from './attention'
import { carriesImages, composePastes, imageFiles, MAX_DRAFT_IMAGES, PasteSequence, uploadImage, type ComposePaste, type DraftImage } from './compose-images'

/** One compose send: its envelopes (images first, then the text) share it; the draft clears once all went. */
interface ComposeSend { sessionId: string; connection: number; revision: number; enter: boolean; sequence: PasteSequence }
/** Image uploads at once (the server reads at most four bodies at a time). */
const UPLOADS_AT_ONCE = 4
import './terminal.css'

const VIEWS = ['active', 'review', 'completed', 'all'] as const
type SessionView = (typeof VIEWS)[number]
function matchesView(item: Session, target: SessionView): boolean {
  if (target === 'all') return true
  if (target === 'review') return Boolean(item.cleanupReason)
  return target === 'completed' ? item.state === 'completed' : item.state !== 'completed'
}

function Workspace({ sessionId }: { sessionId?: string }) {
  const router = useRouter()
  const [all, setAll] = useState<Session[]>([])
  const current = useRef<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [serviceReady, setServiceReady] = useState(false)
  const [serviceUpdateRequired, setServiceUpdateRequired] = useState(false)
  // The service update's confirm dialog (the whole flow lives in it) and its own error.
  const [updating, setUpdating] = useState(false)
  // Copy text: the terminal's text as it was when the sheet opened.
  const [copying, setCopying] = useState(false)
  const readText = useCallback(() => viewHandle.current?.text(), [])
  // Full screen (the host's): Bakin's chrome goes, and the browser's where it can; menus, dialogs and toasts still show.
  const fullscreen = useFullscreen()
  const [updateError, setUpdateError] = useState('')
  const applyTrigger = useRef<HTMLButtonElement>(null)
  /** Set by a successful update: its trigger goes with the banner, so focus goes to New terminal. */
  const updated = useRef(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assignment, setAssignment] = useState('')
  const [captureTab, setCaptureTab] = useState(true)
  const inputHandle = useRef<TerminalInputHandle | null>(null)
  // The last chunk sent: a trailing `\` makes the next Return a line continuation.
  const lastSent = useRef('')
  // Compose drafts by session: held here (they outlive the sheet), stored when they fit, cleared
  // only once the server accepted their paste — and only the revision that was sent, never a
  // later edit. `composing` names each compose paste's envelope by connection and sequence.
  const drafts = useRef(new Map<string, { text: string; kept: boolean; revision: number }>())
  // One send is several envelopes when it carries images (each path its own paste): they share one entry,
  // and the draft clears only once all were accepted.
  const composing = useRef(new Map<number, ComposeSend>())
  // The send in flight: until it is done or stopped, compose cannot send again or drop its images, and the
  // terminal gets focus back only after its last paste (nothing typed lands between its pastes).
  const [sending, setSending] = useState<ComposeSend | undefined>()
  const sendingRef = useRef<ComposeSend | undefined>(undefined)
  const finishSend = useRef((send: ComposeSend) => { void send })
  // Each session's draft images (components/compose-images.ts), held here like the text.
  const draftImages = useRef(new Map<string, DraftImage[]>())
  const imageCounter = useRef(0)
  const imagesFor = (id: string) => draftImages.current.get(id) ?? []
  const setImages = (id: string, change: (images: DraftImage[]) => DraftImage[]) => {
    draftImages.current.set(id, change(imagesFor(id)))
    setDraftVersion(version => version + 1)
  }
  // Their thumbnails are the browser's local copies: given back when the page goes.
  useEffect(() => () => { for (const images of draftImages.current.values()) for (const image of images) URL.revokeObjectURL(image.preview) }, [])
  const [, setDraftVersion] = useState(0)
  // A desktop's compose sheet (a touch device has the key bar's): open for an image or from the menu.
  const [composeOpen, setComposeOpen] = useState(false)
  const desktopCompose = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => { setComposeOpen(false) }, [sessionId])
  const draftFor = (id: string) => drafts.current.get(id) ?? { text: readDraft(id), kept: true, revision: 0 }
  const setDraft = (id: string, text: string) => {
    drafts.current.set(id, { text, kept: writeDraft(id, text), revision: draftFor(id).revision + 1 })
    setDraftVersion(version => version + 1)
  }
  const viewHandle = useRef<TerminalViewHandle | null>(null)
  // Viewer-socket presence, not session state: whether the screen or app that
  // sizes the open session is away, and how many terminal apps are attached.
  const [presence, setPresence] = useState<Presence>({ sizeFrozen: false, nativeClients: 0 })
  // Terminal apps attached per session, for the list (refreshed with it).
  const [apps, setApps] = useState<Record<string, number>>({})
  const [modifiers, setModifiers] = useState<ModifierState>(NO_MODIFIERS)
  const [attempt, setAttempt] = useState(0)
  const [streamStatus, setStreamStatus] = useState('Connecting')
  useEffect(() => { setCaptureTab(true); setAttempt(0); setStreamStatus('Connecting') }, [sessionId])
  // A failed renderer is rebuilt once; failing again within a minute it
  // stays stopped ("Renderer failed") until the operator reconnects.
  const lastRendererRebuild = useRef(0)
  const rendererFailed = useCallback(() => {
    if (Date.now() - lastRendererRebuild.current < 60_000) return
    lastRendererRebuild.current = Date.now()
    setAttempt((value) => value + 1)
  }, [])
  // An ended session with no output to show: the reason, for the open session only.
  const [unavailable, setUnavailable] = useState<{ sessionId: string; reason: UnavailableReason }>()
  const unavailableChanged = useCallback((reason: UnavailableReason) => { if (sessionId) setUnavailable({ sessionId, reason }) }, [sessionId])
  const [agents, setAgents] = useState<SessionOptionsData['agents']>([])
  const [agentsError, setAgentsError] = useState('')
  const agentChoices = useTerminalAgents(agents)
  const [confirm, setConfirm] = useState<SessionConfirmation | null>(null)
  const epoch = useRef(0)
  const listEpoch = useRef(0)
  const update = useCallback((session: Session) => {
    const previous = current.current.find((item) => item.id === session.id)
    if (previous && (previous.revision ?? 0) >= (session.revision ?? 0)) return
    if (!previous) listEpoch.current++
    current.current = [...current.current.filter((item) => item.id !== session.id), session].sort((a, b) => b.createdAt - a.createdAt)
    setAll(current.current)
  }, [])
  const remove = useCallback((ids: (id: string) => boolean) => {
    if (!current.current.some((item) => ids(item.id))) return
    current.current = current.current.filter((item) => !ids(item.id))
    setAll(current.current)
  }, [])
  const refresh = useCallback(async () => {
    try {
      const known = listEpoch.current
      const result = await api<{ sessions: Array<Session & { nativeClients?: number; activity?: string }>; serviceReady: boolean; serviceUpdateRequired?: boolean }>('/sessions')
      for (const { nativeClients: _apps, activity: _activity, ...session } of result.sessions) update(session)
      setApps(Object.fromEntries(result.sessions.map((session) => [session.id, session.nativeClients ?? 0])))
      // Deleted sessions vanish from the server list. Drop them locally, but
      // never against a response older than a session added while in flight.
      if (listEpoch.current === known) {
        const listed = new Set(result.sessions.map((session) => session.id))
        remove((id) => !listed.has(id))
      }
      setServiceReady(result.serviceReady)
      setServiceUpdateRequired(Boolean(result.serviceUpdateRequired))
      setLoadError('')
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'Terminal unavailable') }
    finally { setLoading(false) }
  }, [update, remove])
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer) }, [refresh])
  const loadAgents = useCallback(async () => {
    try { setAgents((await api<SessionOptionsData>('/options')).agents); setAgentsError('') }
    catch { setAgentsError('Agent choices could not be loaded') }
  }, [])
  useEffect(() => { void loadAgents() }, [sessionId, loadAgents])
  // A terminal fills the viewport — it is not a scroll-away document. The
  // immersive header sizes the body for the compact row, so engage that row on
  // open (scroll the tall identity off) instead of leaving the pane overflowing
  // the page until the operator scrolls. Runs before paint, so there is no flash.
  useLayoutEffect(() => {
    if (!sessionId || loading) return
    const shell = document.querySelector('[data-archetype="workspace"]')
    if (shell instanceof HTMLElement) shell.scrollTop = shell.scrollHeight
  }, [sessionId, loading])
  const [viewParam, setViewParam] = useQueryState('view', 'active')
  const viewCount = (target: SessionView) => all.filter((item) => matchesView(item, target)).length
  const requestedView = (VIEWS as readonly string[]).includes(viewParam) ? viewParam as SessionView : 'active'
  // The attention segment only exists while something needs review.
  const view: SessionView = requestedView === 'review' && viewCount('review') === 0 ? 'active' : requestedView
  const [sortQuery, setSortQuery] = useQueryState('sort', 'activity:desc')
  const sortLabels = { title: 'Session', program: 'Program', agent: 'Agent', state: 'Status', activity: 'Last activity' }
  const sortItems = Object.fromEntries(Object.entries(sortLabels).flatMap(([key, label]) => [
    [`${key}:asc`, `${label}: ascending`], [`${key}:desc`, `${label}: descending`],
  ]))
  const sortValue = Object.hasOwn(sortItems, sortQuery) ? sortQuery : 'activity:desc'
  const [sortField, sortDir] = sortValue.split(':') as [keyof typeof sortLabels, 'asc' | 'desc']
  const sortAccessor = (item: Session): string | number | null => sortField === 'activity' ? item.lastActivityAt
    : sortField === 'state' ? item.state === 'running' ? 0 : item.state === 'exited' ? 1 : 2
    : sortField === 'agent' ? item.agentId ? agentChoices.find(agent => agent.id === item.agentId)?.name ?? item.agentId : null
    : item[sortField]
  const visible = all.filter((item) => matchesView(item, view)).sort((a, b) => {
    const left = sortAccessor(a), right = sortAccessor(b)
    if (left == null || right == null) return left == null ? right == null ? 0 : 1 : -1
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
    return sortDir === 'asc' ? compared : -compared
  })
  const session = all.find((item) => item.id === sessionId)
  const openSession = useRef(sessionId)
  openSession.current = sessionId
  const ended = session?.state === 'exited' || session?.state === 'completed'
  const missing = unavailable && unavailable.sessionId === sessionId ? unavailableNotice(unavailable.reason) : undefined
  // An update applied elsewhere (another tab, Health) leaves nothing to confirm.
  useEffect(() => { if (!serviceUpdateRequired && updating && !busy) setUpdating(false) }, [serviceUpdateRequired, updating, busy])
  // What the service update ends first (setup refuses while any session runs).
  const liveSessions = all.filter((item) => item.state === 'running')
  const ownerAgentName = session?.owner.kind === 'agent' ? agents.find((agent) => agent.id === session.owner.id)?.name ?? session.owner.id : undefined
  // The operator is not the tab: any human client drives a human-owned live session.
  const writable = Boolean(session && session.owner.kind === 'human' && session.state === 'running')
  const controlStatus = ended ? 'Ended' : writable ? "You're driving" : ownerAgentName ? `Watching ${ownerAgentName}` : 'Watching'
  const status = session?.historyDeleted ? 'Output history deleted' : ended ? 'Ended' : streamStatus === controlStatus ? streamStatus : `${streamStatus} / ${controlStatus}`
  // One compact status chip sits beside the name instead of a stacked line:
  // green while you drive a live session, muted when ended, amber when the
  // stream is not yet connected.
  const connected = streamStatus.startsWith('Connected')
  const inputEnabled = writable && connected && serviceReady && !busy && !loadError
  // Phones and tablets get the key bar, only while the on-screen keyboard is up (spec D9 item 9).
  const touch = useCoarsePointer()
  const keyed = Boolean(session && !ended && !session.historyDeleted && touch)
  const [editing, editingEvent] = useEditingSession(keyed)
  // Return on the phone keyboard sends the line and puts the keyboard away, so the response has the screen.
  useEnterHidesKeyboard(keyed && editing === 'typing', () => { editingEvent('hide'); inputHandle.current?.blur() },
    () => ({ continued: lastSent.current.endsWith('\\'), modified: modifiers.ctrl !== 'off' || modifiers.alt !== 'off' }))
  // Invalidate stale writes before newly enabled controls can accept input.
  useLayoutEffect(() => { epoch.current++ }, [sessionId, session?.generation, connected, serviceReady])
  const chipTone = session?.historyDeleted || ended ? 'neutral' : !connected ? 'attention' : writable ? 'success' : 'neutral'
  // One word (the tooltip has the rest, e.g. "Watching Patch").
  const chipLabel = session?.historyDeleted ? 'Output deleted' : ended ? 'Ended' : !connected ? streamStatus.split(' / ')[0] : writable ? 'Driving' : 'Watching'
  const statusChip = session && <Badge size="xs" variant="solid" tone={chipTone} role="status" title={status}>{chipLabel}</Badge>
  // What a coding program says about its turn (lib/attention.ts): outlined once acknowledged.
  const attention = session && attentionChip(session)
  const attentionBadgeEl = attention && <Badge size="xs" variant={attention.acknowledged ? 'outline' : 'solid'} tone={attention.tone} title={attention.title} data-attention={session?.attention?.state}>{attention.label}</Badge>
  // Open and focused here: other tabs on this device hear it, so none of them tells this session. Its own
  // lifecycle, beating while the session is open (an attention change never interrupts it).
  const watchingId = session?.state === 'running' ? session.id : undefined
  useEffect(() => {
    if (!watchingId) return
    const tab = clientId()
    const beat = () => setWatching(tab, document.visibilityState === 'visible' && document.hasFocus() ? watchingId : undefined)
    beat()
    const timer = setInterval(beat, WATCHING_BEAT_MS)
    window.addEventListener('focus', beat)
    window.addEventListener('blur', beat)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', beat)
      window.removeEventListener('blur', beat)
      document.removeEventListener('visibilitychange', beat)
      setWatching(tab, undefined)
    }
  }, [watchingId])
  // A state that wants you, seen here, is acknowledged by its occurrence — retried each beat while focused
  // until it lands (the badge and every other device follow).
  const acknowledgeOccurrence = session && wantsYou(session) ? session.attention?.occurrence : undefined
  useEffect(() => {
    if (!watchingId || acknowledgeOccurrence === undefined) return
    const acknowledge = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      void api<Session>('/session', { id: watchingId, operation: 'acknowledge', occurrence: acknowledgeOccurrence }).then((result) => { if (result.id) update(result) }).catch(() => undefined)
    }
    acknowledge()
    const timer = setInterval(acknowledge, WATCHING_BEAT_MS)
    window.addEventListener('focus', acknowledge)
    document.addEventListener('visibilitychange', acknowledge)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', acknowledge)
      document.removeEventListener('visibilitychange', acknowledge)
    }
  }, [watchingId, acknowledgeOccurrence, update])
  // Shown while the session is also open in a terminal app on this Mac (bakin terminal attach).
  const appChip = session && !ended && presence.nativeClients > 0 && <Badge size="xs" variant="outline" title="Also open in a terminal app on this Mac"><AppWindow size={12} />Open in a terminal app</Badge>
  useEffect(() => { setAssignment(session?.agentId ?? '') }, [session?.id, session?.agentId])
  useEffect(() => { setPresence({ sizeFrozen: false, nativeClients: 0 }) }, [sessionId])
  async function operate(operation: string, extra: Record<string, unknown> = {}, targetId = sessionId) {
    const target = current.current.find((item) => item.id === targetId)
    if (!target) return
    setBusy(true); epoch.current++; inputHandle.current?.reset()
    setError('')
    try {
      const result = await api<Session>('/session', { id: target.id, operation, generation: target.generation, ...extra })
      if (result.id) update(result)
      await refresh()
      return true
    } catch (error) { setError(error instanceof Error ? error.message : 'Terminal operation failed'); return false }
    finally { setBusy(false) }
  }
  async function saveDefaultSize(target: Session) {
    setError('')
    try {
      await api('/session', { id: target.id, operation: 'default-size' })
      toast(`New sessions start at ${target.cols}×${target.rows}`, 'success')
    } catch (error) { setError(error instanceof Error ? error.message : 'Default size not saved') }
  }
  /** Send input; the envelope's sequence (its result names it), or false when not sent. */
  function input(data: string, options: { paste?: boolean; enter?: boolean; uploads?: string[]; compose?: boolean } = {}): number | false {
    if (!session || !inputEnabled) return false
    // Nothing else between a compose send's pastes (a Return there would submit half of it).
    if (sendingRef.current && !options.compose) { setError('Wait a moment: the compose draft is still being sent.'); return false }
    lastSent.current = lineTail(lastSent.current, options.enter ? data + '\r' : data)
    markActivity()
    // The viewer socket sequences and coalesces; a refused envelope comes back as a result.
    const sent = inputHandle.current?.send(session.generation, data, options) ?? false
    if (!sent) setError('Input not sent: the terminal is reconnecting.')
    return sent
  }
  /**
   * Compose text as one paste, then Return if asked — one envelope, so the
   * Return goes only once the paste did. The draft clears when the server
   * accepts it, if it is still the text that was sent.
   */
  function sendCompose(text: string, enter: boolean): PasteOutcome {
    if (!session || !inputHandle.current || sendingRef.current) return 'unavailable'
    const ready = imagesFor(session.id).filter((image) => image.status === 'ready' && image.upload)
    // The text as a paste (false: input is not available now).
    const pasted = text ? inputHandle.current.pasteText(text) : ''
    if (pasted === false) return 'unavailable'
    const parts = composePastes(session.program, pasted, ready.map((image) => ({ id: image.id, ...image.upload! })))
    if (!parts.length) return 'unavailable'
    if (parts.some((paste, index) => new TextEncoder().encode(paste.text).length + (enter && index === parts.length - 1 ? 1 : 0) > INPUT_LIMIT_BYTES)) return 'too-long'
    // One paste at a time: the next goes only once the one before it was accepted, so a refusal stops the
    // rest (and the Return) and what went leaves the draft — nothing is sent twice by a retry.
    const sessionId = session.id
    const revision = draftFor(sessionId).revision
    const send: ComposeSend = { sessionId, connection: inputHandle.current.connection(), revision, enter, sequence: new PasteSequence(parts, enter,
      (paste, withEnter) => {
        const sent = input(paste.text, { paste: true, enter: withEnter, uploads: paste.uploads, compose: true })
        if (sent) composing.current.set(sent, send)
        return sent
      },
      (paste) => delivered(sessionId, revision, paste)) }
    if (!send.sequence.start()) return 'unavailable'
    sendingRef.current = send
    setSending(send)
    setComposeOpen(false)
    // After Paste + Enter the response needs the screen (as Return from the keyboard): the keyboard goes away.
    // After Paste the terminal has focus again once the last paste went (finishSend).
    if (enter) editingEvent('hide')
    ;(document.activeElement as HTMLElement | null)?.blur()
    return 'sent'
  }
  finishSend.current = (send: ComposeSend) => {
    if (sendingRef.current !== send) return
    sendingRef.current = undefined
    setSending(undefined)
    if (!send.enter && openSession.current === send.sessionId) { inputHandle.current?.focus(); editingEvent('abc') }
  }
  /** A paste of a compose send went: what it carried leaves the draft (the text only if it was not edited since). */
  function delivered(sessionId: string, revision: number, paste: ComposePaste) {
    if (paste.carriesText && draftFor(sessionId).revision === revision) setDraft(sessionId, '')
    if (!paste.imageIds.length) return
    const sent = new Set(paste.imageIds)
    for (const image of imagesFor(sessionId)) if (sent.has(image.id)) URL.revokeObjectURL(image.preview)
    setImages(sessionId, (images) => images.filter((image) => !sent.has(image.id)))
  }
  /**
   * Images for the open session's draft: each uploaded (only its driver may), a few at once, shown as it
   * goes. At most MAX_DRAFT_IMAGES in a draft.
   */
  const uploadQueue = useRef<Array<() => Promise<void>>>([])
  const uploading = useRef(0)
  const pump = () => {
    while (uploading.current < UPLOADS_AT_ONCE && uploadQueue.current.length) {
      const next = uploadQueue.current.shift()!
      uploading.current++
      void next().finally(() => { uploading.current--; pump() })
    }
  }
  function addImages(files: File[]) {
    if (!session || !files.length) return
    const { id, generation } = session
    const room = Math.max(MAX_DRAFT_IMAGES - imagesFor(id).length, 0)
    if (files.length > room) setError(`A draft holds at most ${MAX_DRAFT_IMAGES} images; ${files.length - room} not added.`)
    for (const file of files.slice(0, room)) {
      const image: DraftImage = { id: `image-${++imageCounter.current}`, label: file.name || 'Pasted image', preview: URL.createObjectURL(file), status: 'uploading' }
      setImages(id, (images) => [...images, image])
      uploadQueue.current.push(() => uploadImage(id, generation, file).then(
        (upload) => setImages(id, (images) => images.map((entry) => entry.id === image.id ? { ...entry, status: 'ready', upload } : entry)),
        (error: unknown) => setImages(id, (images) => images.map((entry) => entry.id === image.id ? { ...entry, status: 'failed', error: error instanceof Error ? error.message : 'Image not added' } : entry)),
      ))
    }
    pump()
  }
  function removeImage(imageId: string) {
    if (!session) return
    const image = imagesFor(session.id).find((entry) => entry.id === imageId)
    if (!image) return
    URL.revokeObjectURL(image.preview)
    setImages(session.id, (images) => images.filter((entry) => entry.id !== imageId))
    // A kept one is removed on the server too (best effort: one left behind is swept after a day).
    if (image.upload) void api('/session', { id: session.id, operation: 'remove-upload', generation: session.generation, name: image.upload.name }).catch(() => undefined)
  }
  /** Compose opens for an image or from the menu: the key bar's sheet on a touch device, the page's own on a desktop. */
  function openCompose() {
    // Mounted and focused within the gesture, so a phone raises the keyboard for the text (the key bar's handoff).
    flushSync(() => { if (keyed) editingEvent('open-compose'); else setComposeOpen(true) })
    document.querySelector<HTMLTextAreaElement>('.terminal-compose textarea')?.focus()
  }
  /** An image pasted or dropped on the terminal joins the draft (before xterm sees the paste; text stays the terminal's). */
  const imageInput = {
    onPasteCapture: (event: React.ClipboardEvent) => {
      if (!writable || !carriesImages(event.clipboardData)) return
      event.preventDefault(); event.stopPropagation()
      openCompose(); addImages(imageFiles(event.clipboardData.files))
    },
    onDragOverCapture: (event: React.DragEvent) => { if (writable && carriesImages(event.dataTransfer)) event.preventDefault() },
    onDropCapture: (event: React.DragEvent) => {
      if (!writable || !carriesImages(event.dataTransfer)) return
      event.preventDefault(); event.stopPropagation()
      openCompose(); addImages(imageFiles(event.dataTransfer.files))
    },
  }
  // A connection that ends takes its envelopes with it: their compose entries retire, their drafts stay.
  const streamChanged = (status: string) => {
    setStreamStatus(status)
    if (status !== 'Connected') {
      composing.current.clear()
      if (sendingRef.current) finishSend.current(sendingRef.current)
    }
  }
  const handleResult = useCallback((result: InputResult) => {
    const entry = composing.current.get(result.viewerSeq)
    composing.current.delete(result.viewerSeq)
    // Only this connection's envelope (sequences restart with each).
    const composed = entry && entry.connection === inputHandle.current?.connection() ? entry : undefined
    // One paste of the send went: the next follows (a refusal stops the rest; what did not go stays in the draft).
    if (composed && result.status === 'accepted') {
      const next = composed.sequence.accepted()
      if (next === false) setError('Not all of the draft was sent: the terminal is reconnecting. What did not go is kept.')
      if (next === false || next === 'done') finishSend.current(composed)
    } else if (composed) finishSend.current(composed)
    if (result.status === 'accepted') return
    epoch.current++
    // A compose draft whose paste did not go stays, so it can be checked and sent again by hand.
    const kept = composed !== undefined ? ' Your compose draft is kept.' : ''
    setError(result.status === 'uncertain' ? `May have been delivered: ${result.error ?? 'the connection dropped'}.${kept}` : `Input not sent: ${result.error ?? 'refused'}.${kept}`)
    void refresh()
  }, [refresh])
  // Claim-on-type: typing while watching takes over, after a one-time confirm
  // that is remembered for CLAIM_GRACE_MS so it does not nag on every keystroke.
  const CLAIM_GRACE_MS = 15 * 60 * 1000
  const [claimData, setClaimData] = useState<string | null>(null)
  const activityAt = useRef(Date.now())
  const [idleReturn, setIdleReturn] = useState(false)
  const markActivity = useCallback(() => { activityAt.current = Date.now(); setIdleReturn(false) }, [])
  function claimGraceActive() { try { return Date.now() - Number(localStorage.getItem('bakin-terminal-claimed-at') ?? 0) < CLAIM_GRACE_MS } catch { return false } }
  function recordClaim() { try { localStorage.setItem('bakin-terminal-claimed-at', String(Date.now())) } catch { /* private mode */ } }
  async function takeAndSend(data: string, targetId: string) {
    markActivity()
    if (!await operate('take', {}, targetId)) return
    const latest = current.current.find((item) => item.id === targetId)
    // The input handle belongs to whatever session is open now: never type
    // into it if the operator navigated away while the takeover ran.
    if (!data || !latest || openSession.current !== targetId || latest.owner.kind !== 'human' || latest.state !== 'running') return
    if (!inputHandle.current?.send(latest.generation, data)) setError('Input not sent: the terminal is reconnecting.')
  }
  function handleClaim(data: string) {
    const target = current.current.find((item) => item.id === sessionId)
    if (!target || target.owner.kind !== 'agent' || target.state !== 'running') return
    if (claimGraceActive()) { recordClaim(); void takeAndSend(data, target.id); return }
    setClaimData(data)
  }
  // Auto hand-back: while you drive a session with an assigned agent, going idle
  // returns control so the agent is never locked out. A 20s warning offers a
  // "Keep driving" escape. Navigating away hands back immediately.
  const IDLE_HANDBACK_MS = 2 * 60 * 1000
  const returnControl = useRef(() => {})
  returnControl.current = () => { void operate('return') }
  const drivingWithAgent = writable && Boolean(session?.agentId)
  useEffect(() => {
    if (!drivingWithAgent) return
    activityAt.current = Date.now()
    const timer = setInterval(() => {
      const idle = Date.now() - activityAt.current
      if (idle >= IDLE_HANDBACK_MS + 20_000) { returnControl.current(); setIdleReturn(false) }
      else if (idle >= IDLE_HANDBACK_MS) setIdleReturn(true)
    }, 5000)
    return () => clearInterval(timer)
  }, [drivingWithAgent, session?.id, IDLE_HANDBACK_MS])
  // Hand back immediately when leaving a session you were driving.
  const leaving = useRef<{ id: string } | null>(null)
  useEffect(() => {
    const prev = leaving.current
    if (prev && prev.id !== sessionId) void api('/session', { id: prev.id, operation: 'return' }).catch(() => {})
    leaving.current = drivingWithAgent && session ? { id: session.id } : null
  })
  useEffect(() => () => { if (leaving.current) void api('/session', { id: leaving.current.id, operation: 'return' }).catch(() => {}) }, [])
  async function setup() {
    setBusy(true); setError('')
    try { await api('/service', {}); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : 'Service setup failed') }
    finally { setBusy(false) }
  }
  /**
   * The service update: the server ends exactly the live sessions this
   * dialog listed, then restarts the service — or refuses, ending nothing,
   * when the list no longer matches or no update is due (lib/sessions.ts
   * applyServiceUpdate). The dialog stays busy until the page has the result.
   */
  async function applyUpdate(end: string[]) {
    setBusy(true); setUpdateError('')
    try {
      await api('/service/update', { end })
      updated.current = true
      setUpdating(false)
      toast('Terminal service updated', 'success')
    } catch (error) { setUpdateError(error instanceof Error ? error.message : 'The service update failed') }
    finally { await refresh(); setBusy(false) }
  }
  async function reopen(target: Session) {
    // A dead session cannot be reconnected — there is no live process. Reopen
    // starts a fresh session in the same directory (reusing an existing
    // checkout, never minting a second worktree) with the same assignment.
    setBusy(true); setError('')
    try {
      const created = await api<Session>('/sessions', { title: target.title, cwd: target.cwd, program: target.program, checkout: 'existing', agentId: target.agentId || undefined, taskId: target.taskId || undefined, projectId: target.projectId || undefined, size: estimateTerminalSize() })
      update(created); router.push(`/terminal/${encodeURIComponent(created.id)}`)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not reopen session') }
    finally { setBusy(false) }
  }
  const newTerminal = <Tooltip><TooltipTrigger render={<Button data-terminal-new="" size="sm" onClick={() => setCreating(true)} disabled={!serviceReady || Boolean(loadError) || busy} focusableWhenDisabled />}><Plus size={16} />New terminal</TooltipTrigger><TooltipContent>New terminal. Create a persistent shell or coding CLI session.</TooltipContent></Tooltip>
  const back = <Tool label="Back to terminals" description="Return to the session list." render={<Button size="icon-sm" variant="ghost" aria-label="Back to terminals" role="link" nativeButton={false} render={<PluginLink to="/terminal" />} />}><ArrowLeft size={16} /></Tool>
  const state = loading ? <SystemState kind="loading" scope="page" title="Loading terminals" description="Checking terminal service and sessions." />
    : loadError && all.length === 0 ? <SystemState kind="error" scope="page" title="Terminals could not be loaded" description={loadError} action={<Button variant="outline" onClick={() => void refresh()}><RotateCw size={16} />Retry</Button>} />
    : !serviceReady && all.length === 0 ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="Terminal service is not set up" description="Set up the persistent service to start using Terminal. Bakin installs tmux with this plugin. If tmux is missing, open Health and run the plugin assets repair, or run bakin install plugin-assets. If this machine cannot download it, install tmux manually." action={<Button disabled={busy} onClick={() => void setup()}><Play size={16} />Set up service</Button>} />
    : all.length === 0 ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="No terminals yet" description="No terminal sessions have been created." action={newTerminal} /> : undefined
  const feedback = <>
    {/* Problems above a list that is still shown are notices (kit Banner, danger), not empty states. */}
    {!serviceReady && all.length > 0 && <Banner headingLevel={2} tone="danger" announce="polite" title="Terminal service is unavailable" description="Open Health and run the plugin assets repair, or run bakin install plugin-assets, then set up the service." action={<Button size="sm" variant="outline" disabled={busy} onClick={() => void setup()}>Set up service</Button>} />}
    {loadError && all.length > 0 && <Banner headingLevel={2} tone="danger" announce="polite" title="Terminals could not be refreshed" description={`${loadError}. The list shows the last refresh; Terminal tries again every few seconds.`} action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RotateCw size={16} />Retry</Button>} />}
    {error && <Alert tone="danger"><AlertDescription>{error}</AlertDescription></Alert>}
  </>
  // The list's notice (a session's own page stays the terminal's): a recommendation, not a gate —
  // info, not attention; the action is the Banner stories' outline button.
  const updateNotice = serviceUpdateRequired && serviceReady && <Banner headingLevel={2} tone="info" title="Terminal service update available"
    description="Restarts Terminal's tmux with the current configuration. Sessions keep working until then."
    action={<Button ref={applyTrigger} size="sm" variant="outline" disabled={busy} onClick={() => { setUpdateError(''); updated.current = false; setUpdating(true) }}>Apply update</Button>} />
  const controls = session && <Inline gap="dense" wrap={false} aria-label="Terminal controls">
            {/* Back to typing after the toggle with a mouse (on touch, focusing would raise the keyboard). */}
            <Tool label={fullscreen.active ? 'Exit full screen' : 'Full screen'} description={fullscreen.active ? 'Back to the page.' : 'Fill the screen with this terminal.'} active={fullscreen.active} onClick={() => { fullscreen.toggle(); if (!window.matchMedia('(pointer: coarse)').matches) inputHandle.current?.focus() }}>{fullscreen.active ? <Shrink size={16} /> : <Expand size={16} />}</Tool>
            {!ended && !session.historyDeleted && <SizeControl session={session} frozen={presence.sizeFrozen} busy={busy} onMinFont={() => viewHandle.current?.refit()} onFit={() => { if (!viewHandle.current?.fitToDevice()) setError('Size not changed: the terminal is reconnecting.') }} onRestore={() => { if (!viewHandle.current?.restoreSize()) setError('Size not changed: the terminal is reconnecting.') }} />}
            <Popover>
              <Tool label="Session details" description="View the working directory, agent assignment, and linked work." render={<PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Session details" />} />}><Info size={16} /></Tool>
              <PopoverContent align="end">
                <Stack gap="item">
                  <PopoverTitle>Session details</PopoverTitle>
                  <Stack gap="dense">
                    <Text weight="semibold">{session.title}</Text>
                    <Text size="meta" tone="muted" mono>{session.cwd}</Text>
                    <Text size="meta" tone="muted" mono>ID {shortId(session)}</Text>
                    <Text size="meta" tone="muted">{session.program} / {session.state}</Text>
                    <Text size="meta" tone="muted">{status}</Text>
                    {session.worktreePath && <Badge size="xs" variant="outline">Worktree retained</Badge>}
                  </Stack>
                  {!ended && <Stack gap="dense">
                    <Text size="meta" weight="semibold">Continue in a terminal app</Text>
                    <Panel variant="code" padding="compact" className="flex min-w-0 items-center gap-bakin-2">
                      <code className="min-w-0 flex-1 break-all text-bakin-text-primary">{attachCommand(session)}</code>
                      <CopyButton text={attachCommand(session)} label="Copy attach command" />
                    </Panel>
                    <Text size="meta" tone="muted">Run it in Ghostty or any terminal on this Mac. Detach with Ctrl-b d.</Text>
                  </Stack>}
                  <Inline gap="dense">
                    <div className="min-w-0 flex-1"><AgentSelect className="w-full" ariaLabel="Assigned agent" value={assignment} onValueChange={setAssignment} agents={agentChoices} allowNone disabled={busy || Boolean(agentsError)} /></div>
                    <Tool label="Assign agent" description="Apply the selected agent to this session." disabled={busy || Boolean(agentsError) || assignment === (session.agentId ?? '')} onClick={() => void operate('assign', { agentId: assignment || undefined })}><UserRoundCheck size={16} /></Tool>
                  </Inline>
                  {agentsError && <SystemState kind="error" scope="inline" title={agentsError} description="Current assignment is unchanged." action={<Button size="sm" variant="outline" onClick={() => void loadAgents()}>Retry agents</Button>} />}
                  {session.taskId && <PluginLink to={`/tasks?taskId=${encodeURIComponent(session.taskId)}`}><CornerDownLeft size={14} />Task {session.taskId}</PluginLink>}
                  {session.projectId && <PluginLink to={`/projects/${encodeURIComponent(session.projectId)}`}><CornerDownLeft size={14} />Project {session.projectId}</PluginLink>}
                </Stack>
              </PopoverContent>
            </Popover>
            {ended
              ? <Tool label="Reopen" description="Start a fresh session in the same directory. Ended sessions cannot be reconnected." disabled={busy} onClick={() => void reopen(session)}><RotateCw size={16} /></Tool>
              : <>
                <Tool
                  label={writable ? (ownerAgentName ? `Hand back to ${ownerAgentName}` : "You're driving") : 'Take over'}
                  description={writable
                    ? (session.agentId ? `You're driving. Hand keyboard input back to ${ownerAgentName}; the program keeps running.` : "You're driving this session. Assign an agent to hand control back.")
                    : `Take over keyboard input.${ownerAgentName ? ` ${ownerAgentName} will pause sending input.` : ''} The running program is not interrupted.`}
                  active={writable}
                  disabled={busy || (writable && !session.agentId)}
                  onClick={() => void operate(writable ? 'return' : 'take')}><Hand size={16} /></Tool>
                <Tool label="Interrupt process" description="Send Ctrl+C to the foreground program. You must be driving." disabled={busy || !writable} onClick={() => input('\x03')}><Square size={16} /></Tool>
              </>}
            <SessionActions session={session} busy={busy} onOperate={(operation, id) => void operate(operation, {}, id)} onConfirm={setConfirm}>
                <DropdownMenuSwitchItem checked={captureTab} onCheckedChange={setCaptureTab} disabled={session.historyDeleted}><Keyboard size={16} />Capture Tab</DropdownMenuSwitchItem>
                {!keyed && !ended && <DropdownMenuItem disabled={!writable} onClick={openCompose}><MessageSquareText size={16} />Compose…</DropdownMenuItem>}
                <DropdownMenuItem disabled={session.historyDeleted || Boolean(missing)} onClick={() => setCopying(true)}><ClipboardCopy size={16} />Copy text…</DropdownMenuItem>
                <DropdownMenuItem disabled={session.historyDeleted} onClick={() => setAttempt((value) => value + 1)}><RotateCw size={16} />Reconnect terminal</DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={() => void saveDefaultSize(session)}><Ruler size={16} />Use this size as the default</DropdownMenuItem>
                <DropdownMenuSeparator />
            </SessionActions>
        </Inline>
  return <TooltipProvider>{!sessionId ? <Page data-terminal-ui-ready={!loading ? '' : undefined}>
    <PageHeader title="Terminal" meta={!loading && !loadError && serviceReady ? <Badge size="xs" variant="outline">{all.filter((item) => item.state === 'running').length} running</Badge> : undefined} actions={all.length > 0 ? newTerminal : undefined} />
    <PageBody label="Terminal sessions">
      {updateNotice}
      {feedback}
      {state ?? <Stack gap="item" align="start" className="min-h-0 w-full flex-1">
        <SegmentedControl
          size="sm"
          ariaLabel="Session view"
          value={view}
          onValueChange={setViewParam}
          options={[
            { value: 'active', label: 'Active' },
            ...(viewCount('review') > 0 ? [{ value: 'review' as const, label: 'Needs review' }] : []),
            { value: 'completed', label: 'Completed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Select items={sortItems} value={sortValue} onValueChange={next => { if (next && Object.hasOwn(sortItems, next)) setSortQuery(next) }}>
          <SelectTrigger aria-label="Sort terminals"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(sortItems).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
        {visible.length === 0 ? <SystemState className="w-full" kind="no-results" scope="page" title="No sessions in this view" description="Sessions in other states are hidden by the current view." action={<Button variant="outline" onClick={() => setViewParam('all')}>Show all sessions</Button>} /> : <DataTable
        className="w-full"
        label="Terminal sessions"
        rows={visible}
        rowKey={(item) => item.id}
        sort={{ field: sortField, dir: sortDir }}
        onSortChange={key => setSortQuery(`${key}:${sortField === key && sortDir === 'asc' ? 'desc' : 'asc'}`)}
        collapseBelow="3xl" listVariant="separated"
        onRowActivate={(item) => router.push(`/terminal/${encodeURIComponent(item.id)}`)}
        rowActivateLabel={(item) => `Open terminal: ${item.title}`}
        columns={[
          { key: 'title', header: 'Session', narrow: 'primary', sortable: true, sortValue: (item) => item.title, headClassName: 'w-1/4', cellClassName: 'whitespace-normal break-words', cell: (item) => <Text weight="semibold">{item.title}</Text> },
          { key: 'program', header: 'Program', narrow: 'meta', sortable: true, sortValue: (item) => item.program },
          { key: 'agent', header: 'Agent', narrow: 'meta', sortable: true, cellClassName: 'whitespace-normal', sortValue: (item) => item.agentId ? agentChoices.find((agent) => agent.id === item.agentId)?.name ?? item.agentId : null, cell: (item) => {
            if (!item.agentId) return <Text size="meta" tone="muted">Unassigned</Text>
            const choice = agentChoices.find((agent) => agent.id === item.agentId)
            const name = choice?.name ?? item.agentId
            return <Inline gap="dense" wrap={false} className="min-w-0"><AgentAvatar size="xs" decorative agent={{ id: item.agentId, name, imageSrc: choice?.imageSrc, color: choice?.color }} /><Text size="meta" className="truncate">{name}</Text></Inline>
          } },
          { key: 'state', header: 'Status', narrow: 'meta', sortable: true, sortValue: (item) => item.state === 'running' ? 0 : item.state === 'exited' ? 1 : 2, cell: (item) => <Stack gap="dense" align="start"><Badge size="xs" variant="solid" tone={item.state === 'running' ? 'success' : 'neutral'}>{item.state === 'running' ? 'Running' : item.state === 'exited' ? 'Exited' : 'Completed'}</Badge>{(() => { const chip = attentionChip(item); return chip && <Badge size="xs" variant={chip.acknowledged ? 'outline' : 'solid'} tone={chip.tone} title={chip.title}>{chip.label}</Badge> })()}{item.state === 'running' && (apps[item.id] ?? 0) > 0 && <Badge size="xs" variant="outline"><AppWindow size={12} />Open in a terminal app</Badge>}{item.worktreePath && <Badge size="xs" variant="soft">Worktree retained</Badge>}</Stack> },
          { key: 'activity', header: 'Last activity', narrow: 'label', sortable: true, sortValue: (item) => item.lastActivityAt, cell: (item) => <Text size="meta" tone="muted" title={new Date(item.lastActivityAt).toLocaleString()}>{formatAge(new Date(item.lastActivityAt).toISOString())}</Text> },
          { key: 'cwd', header: 'Working directory', narrow: 'label', headClassName: 'w-1/3', cellClassName: 'whitespace-normal', cell: (item) => <Text size="meta" tone="muted" mono className="block break-all">{item.cwd}</Text> },
          { key: 'actions', header: 'Actions', narrow: 'trailing', hideLabel: true, align: 'end', headClassName: 'w-(--bakin-layout-size-row)', cell: (item) => <SessionActions session={item} busy={busy} label={`Actions for ${item.title}`} allowTake onOperate={(operation, id) => void operate(operation, {}, id)} onConfirm={setConfirm} /> },
        ]}
      />}
      </Stack>}
    </PageBody>
  </Page> : <WorkspacePage mode="immersive" viewport="visual" className="terminal-page" data-terminal-ui-ready={!loading ? '' : undefined}>
    <WorkspacePageHeader>
        <PageHeader navigation={back} eyebrow="Terminal" title={session?.title ?? 'Terminal'} meta={<Inline gap="dense" wrap={false}>{statusChip}{attentionBadgeEl}{appChip}</Inline>} actions={controls} />
    </WorkspacePageHeader>
    <WorkspacePageCompactHeader navigation={back} title={<Inline gap="dense" wrap={false} className="min-w-0 items-center"><span className="truncate">{session?.title ?? 'Terminal'}</span>{statusChip}{attentionBadgeEl}{appChip}</Inline>} action={controls} />
    {/* The accessory slot stays mounted for any live session and only its
        content follows the device and keyboard: adding or removing the slot
        itself restructures the body and would remount the terminal (dropping
        the keyboard). */}
    <WorkspacePageBody inputAccessory={session && !ended && !session.historyDeleted
      ? keyed && editing !== 'idle' ? <KeyBar key={session.id} session={editing} disabled={!inputEnabled || Boolean(sending)} modifiers={modifiers} draft={draftFor(session.id)}
          onKey={key => inputHandle.current?.key(key)} onModifier={(modifier, action) => inputHandle.current?.modifier(modifier, action)}
          onSheet={() => { editingEvent('open-sheet'); inputHandle.current?.blur() }}
          onCompose={() => editingEvent('open-compose')}
          onDraft={text => setDraft(session.id, text)} onPaste={sendCompose}
          onKeyboard={() => { inputHandle.current?.focus(); editingEvent('abc') }}
          onHide={() => { editingEvent('hide'); inputHandle.current?.blur() }}
          images={imagesFor(session.id)} onAddImages={addImages} onRemoveImage={removeImage} />
        : !keyed && composeOpen ? <ComposeSheet key={session.id} draft={draftFor(session.id).text} kept={draftFor(session.id).kept} disabled={!inputEnabled || Boolean(sending)} textarea={desktopCompose}
            images={imagesFor(session.id)} onDraft={text => setDraft(session.id, text)} onSend={sendCompose} onAddImages={addImages} onRemoveImage={removeImage}
            onClose={() => { setComposeOpen(false); inputHandle.current?.focus() }} />
        : <></>
      : undefined}>
      <Stack as="section" gap="none" className="min-h-0 flex-1 overflow-y-auto" aria-label="Selected terminal">
        {(loadError && all.length > 0 || error) && <Stack gap="item" className="shrink-0 p-bakin-4">
          {feedback}
        </Stack>}
        {state ?? (!session ? <SystemState kind="initial-empty" scope="page" icon={<Terminal size={32} />} title="Terminal not found" description="This session is not available." action={<Button variant="outline" nativeButton={false} render={<PluginLink to="/terminal" />}>Back to terminals</Button>} /> : <>
          {(!serviceReady || session.cleanupReason || (idleReturn && drivingWithAgent)) && <Stack gap="item" className="shrink-0 p-bakin-4">
          {!serviceReady && <SystemState kind="error" scope="inline" title="Terminal service unavailable" description="Existing sessions are retained." action={<Button disabled={busy} onClick={() => void setup()}>Set up service</Button>} />}
          {idleReturn && drivingWithAgent && <Alert tone="attention"><AlertDescription><Inline gap="dense" wrap className="items-center justify-between"><span>You've been idle — returning control to {ownerAgentName ?? 'the agent'} shortly.</span><Button size="sm" variant="outline" onClick={markActivity}>Keep driving</Button></Inline></AlertDescription></Alert>}
          {session.cleanupReason && <Alert tone="attention"><AlertDescription>{session.cleanupReason}</AlertDescription></Alert>}
          </Stack>}
          <Separator />
          {session.historyDeleted ? <SystemState kind="initial-empty" scope="page" title="Output history deleted" description="Session metadata is retained." /> : missing ? <SystemState kind="error" recovery="unavailable" scope="page" title={missing.title} description={missing.description} /> : <div className="contents" {...imageInput}><TerminalCanvas key={session.id} session={session} writable={writable} offerKeyboard={keyed && editing === 'idle' && Boolean(inputEnabled)} inputEnabled={Boolean(inputEnabled) && !sending} inputHandle={inputHandle} viewHandle={viewHandle} onModifiersChange={setModifiers} captureTab={captureTab} attempt={attempt} onStatus={streamChanged} onInput={(data, paste) => input(data, { paste })} onClaim={handleClaim} onSession={update} onPresence={setPresence} onResult={handleResult} onRendererFailed={rendererFailed} onUnavailable={unavailableChanged} /></div>}
        </>)}
      </Stack>
    </WorkspacePageBody>
  </WorkspacePage>}
    <CopyTextSheet open={copying} read={readText} onOpenChange={setCopying} />
    <NewSession open={creating} onOpenChange={setCreating} onCreated={(created) => { update(created); router.push(`/terminal/${encodeURIComponent(created.id)}`) }} />
    <ConfirmDialog open={confirm !== null} busy={busy} error={error || undefined} onCancel={() => setConfirm(null)}
      title={confirm?.operation === 'terminate' ? 'Terminate this session?' : confirm?.operation === 'delete' ? 'Delete this session?' : 'Delete output history?'}
      description={`${all.find((item) => item.id === confirm?.id)?.title ?? 'Terminal'}. ${confirm?.operation === 'terminate' ? 'This stops the running process. Unfinished worktrees will be retained.' : confirm?.operation === 'delete' ? `The session and all of its retained output will be permanently deleted.${all.find((item) => item.id === confirm?.id)?.worktreePath ? ' Its worktree checkout is removed; committed work on its branch is kept.' : ''}` : 'The retained terminal output will be permanently deleted. Session metadata is retained.'}`}
      confirmLabel={confirm?.operation === 'terminate' ? 'Terminate' : confirm?.operation === 'delete' ? 'Delete session' : 'Delete output'}
      onConfirm={async () => {
        if (!confirm) return
        const target = confirm
        if (!await operate(target.operation, {}, target.id)) return
        setConfirm(null)
        if (target.operation !== 'delete') return
        remove((id) => id === target.id)
        if (target.id === sessionId) router.push('/terminal')
      }} />
    <ConfirmDialog open={updating} busy={busy} error={updateError || undefined} onCancel={() => setUpdating(false)}
      title="Apply the Terminal service update?"
      finalFocus={() => !updated.current && applyTrigger.current?.isConnected ? applyTrigger.current : document.querySelector<HTMLElement>('[data-terminal-new]')}
      description={`Terminal restarts its tmux with the current configuration${liveSessions.length ? '. Setup needs every session ended first: these end now, stopping their programs and disconnecting any terminal app attached to them' : ''}. tmux's own scrollback for ended sessions is dropped; the output Bakin saved and retained worktrees are kept.`}
      confirmLabel={liveSessions.length ? `End ${liveSessions.length} ${liveSessions.length === 1 ? 'session' : 'sessions'} and update` : 'Apply update'}
      busyLabel="Updating…" confirmTone={liveSessions.length ? 'danger' : 'primary'}
      onConfirm={() => void applyUpdate(liveSessions.map((item) => item.id))}>
      {liveSessions.length > 0 && <Stack as="ul" role="list" gap="dense" aria-label="Sessions that will end">
        {liveSessions.map((item) => <li key={item.id}><Text size="meta" weight="semibold">{item.title}</Text> <Text size="meta" tone="muted">· {item.program}{item.agentId ? ` · ${agents.find((agent) => agent.id === item.agentId)?.name ?? item.agentId}` : ''}{(apps[item.id] ?? 0) > 0 ? ' · open in a terminal app' : ''}</Text></li>)}
      </Stack>}
    </ConfirmDialog>
    <ConfirmDialog open={claimData !== null} busy={busy} error={error || undefined} onCancel={() => setClaimData(null)}
      title="Take over this session?"
      description={`${ownerAgentName ?? 'The agent'} will stop sending input until you hand control back. The running program keeps running.`}
      confirmLabel="Take over" confirmTone="primary"
      onConfirm={async () => {
        if (claimData === null || !sessionId) return
        const data = claimData
        setClaimData(null)
        recordClaim()
        await takeAndSend(data, sessionId)
      }} />
  </TooltipProvider>
}
export function TerminalPage(props: { sessionId?: string }) { return <Suspense><Workspace {...props} /></Suspense> }
