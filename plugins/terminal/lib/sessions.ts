import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { authorize, createSchema, DAY, DeliveryUncertainError, TerminalError, type CreateInput, type Principal, type Session, type SizeClaimant, type TerminalSettings } from './contracts'
import type { NativeClient, ProcessDriver } from './processes'
import { claimSize, clampSize, nextSize } from './sizing'
import { Screen } from './screen'
import { Store } from './store'

interface WorktreeResult { ok: boolean; error?: string; worktreePath?: string }
/** How long a launched terminal app has to confirm its pid (spec D7). */
export const RESERVATION_MS = 15_000
/** A minted, single-use permission for one terminal app to attach. */
interface Reservation {
  sessionId: string
  generation: number
  expires: number
  /** Set by the confirm; the reservation is spent when this client is admitted. */
  pid?: number
  settle?: { resolve(): void; reject(error: Error): void }
}
const nativeViewer = (pid: number) => `native:${pid}`
/** The creating screen's grid and what kind of screen it is (it holds the size claim). */
export type StartSize = { cols: number; rows: number } & SizeClaimant

export interface SessionOptions {
  settings(): TerminalSettings
  prepare(input: { repoPath: string; sessionId: string; agent: string }): Promise<WorktreeResult | undefined>
  release(input: { sessionId: string; worktreePath: string; teardown?: boolean }): Promise<WorktreeResult | undefined>
  validateLinks?(input: CreateInput): Promise<void>
  now?(): number
}

export class Sessions {
  private pending: Promise<unknown> = Promise.resolve()
  private screens = new Map<string, Screen>()
  private outputListeners = new Map<string, Set<() => void>>()
  private sessionListeners = new Map<string, Set<(session: Session) => void>>()
  private reservations = new Map<string, Reservation>()
  /** Admitted terminal apps by session, keyed by tmux client pid. */
  private natives = new Map<string, Map<number, NativeClient>>()
  private nativeListeners = new Map<string, Set<() => void>>()
  private reconciling = new Set<string>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private closed = false
  constructor(readonly store: Store, private driver: ProcessDriver, private options: SessionOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now() }
  /** Persist and tell live viewers (ownership, size and state reach them at once). */
  private save(session: Session): void {
    this.store.save(session)
    for (const listener of this.sessionListeners.get(session.id) ?? []) listener(session)
  }
  onSessionChange(id: string, listener: (session: Session) => void): () => void {
    let listeners = this.sessionListeners.get(id)
    if (!listeners) this.sessionListeners.set(id, listeners = new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.sessionListeners.delete(id)
    }
  }
  /** Settles once everything queued so far has run. */
  idle(): Promise<void> { return this.pending.then(() => undefined) }
  private enabled(): string[] { return (this.options.settings().enabledAgents ?? []).map((agent) => agent.id) }
  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(() => { if (this.closed) throw new TerminalError('Terminal manager is shutting down', 503); return work() })
    this.pending = next.catch(() => {})
    return next
  }
  list(principal: Principal): Session[] {
    if (principal.kind === 'agent' && !this.enabled().includes(principal.id)) throw new TerminalError('Terminal is disabled for this agent', 403)
    return this.store.sessions().filter((session) => principal.kind === 'human' || session.agentId === principal.id)
  }
  get(id: string, principal: Principal): Session {
    const session = this.store.sessions().find((entry) => entry.id === id)
    if (!session) throw new TerminalError('Session not found', 404)
    authorize(session, principal, this.enabled())
    return session
  }
  /** Boot: reattach live sessions (a restarted service may have lost titles). */
  start(): Promise<void> { return this.setupService(async () => {}) }
  /** The newest stored output cursor for a session (0 when none). */
  latestCursor(id: string): number {
    return this.store.output(id, Number.MAX_SAFE_INTEGER).cursor
  }
  /**
   * Resolve once output past `cursor` is stored, the signal aborts, or
   * `idleMs` passes (a keepalive for long-quiet sessions). Subscribes before
   * re-checking the store, so output landing in between is never missed.
   */
  nextOutput(id: string, cursor: number, signal: AbortSignal, idleMs = 15_000): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener('abort', done)
        resolve()
      }
      const unsubscribe = this.onOutput(id, done)
      const timer = setTimeout(done, idleMs)
      signal.addEventListener('abort', done, { once: true })
      if (signal.aborted || this.latestCursor(id) > cursor) done()
    })
  }
  /** Hear about newly stored output for a session (push instead of polling). */
  onOutput(id: string, listener: () => void): () => void {
    let listeners = this.outputListeners.get(id)
    if (!listeners) this.outputListeners.set(id, listeners = new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.outputListeners.delete(id)
    }
  }
  refreshStates(): Promise<void> {
    return this.run(async () => {
      for (const session of this.store.sessions()) {
        if (session.state === 'running' && !await this.driver.alive(session.id)) {
          session.state = 'exited'
          this.forgetNatives(session.id)
          this.save(session)
        }
      }
    })
  }
  /**
   * Attach and adopt tmux's actual window before anything reads or writes
   * through the attachment (the record may be stale: a resize whose save
   * failed, a crash). False when tmux cannot say: the attachment is dropped
   * again, and the next viewer sync retries.
   */
  private async attach(session: Session): Promise<boolean> {
    this.attachUnreconciled(session)
    try {
      this.adoptSize(session, await this.driver.windowSize(session.id))
    } catch {
      await this.stopScreen(session.id)
      return false
    }
    // Terminal apps already attached (one left over from before a restart, or
    // a raw attach while nobody watched) meet the same admission check.
    await this.reconcileClients(session.id).catch(() => undefined)
    return true
  }
  private attachUnreconciled(session: Session): void {
    if (this.screens.has(session.id)) return
    const screen = new Screen(session.cols, session.rows)
    this.screens.set(session.id, screen)
    this.driver.attach(session, (data) => {
      if (this.closed || this.screens.get(session.id) !== screen) return
      for (let offset = 0; offset < data.length; offset += 65536) {
        const chunk = data.slice(offset, offset + 65536)
        // Screen.failed exposes bounded-parser overflow to readers; a fresh attachment recovers it.
        void screen.write(chunk, () => {
          this.store.append(session.id, chunk)
          for (const listener of this.outputListeners.get(session.id) ?? []) listener()
        }).catch(() => undefined)
      }
    }, () => this.clientsChanged(session.id))
  }
  private async stopScreen(id: string): Promise<void> {
    const screen = this.screens.get(id)
    this.screens.delete(id)
    await this.driver.detach(id)
    if (screen) { await screen.drain(); screen.close() }
  }
  private ensureScreen(id: string, principal: Principal): Promise<Screen> {
    return this.run(async () => {
      const session = this.get(id, principal)
      await this.ensureAttached(session)
      return this.screens.get(id)!
    })
  }
  private async ensureAttached(session: Session): Promise<void> {
    if (session.state !== 'running') throw new TerminalError('Live terminal screen unavailable', 503)
    if (!this.driver.connected(session.id) || this.screens.get(session.id)?.failed || !this.screens.has(session.id)) {
      await this.stopScreen(session.id)
      if (!await this.driver.alive(session.id)) throw new TerminalError('Terminal process has exited', 409)
      if (!await this.attach(session)) throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    }
  }
  /**
   * `size` is the creating screen's grid (a human's pane or terminal); it
   * makes that viewer the size authority. Without one — agents — the session
   * starts at the configured default with nobody sizing it yet.
   */
  create(raw: unknown, principal: Principal, size?: StartSize): Promise<Session> {
    return this.run(async () => {
      const input = createSchema.parse(raw)
      this.list(principal)
      const agentId = principal.kind === 'agent' ? principal.id : input.agentId
      if (agentId && !this.enabled().includes(agentId)) throw new TerminalError('Terminal is disabled for the assigned agent', 403)
      const all = this.store.sessions()
      if (all.filter((s) => s.state === 'running').length >= (this.options.settings().maxSessions ?? 10)) throw new TerminalError('Live terminal session limit reached')
      await this.options.validateLinks?.(input)
      const cwd = realpathSync(input.cwd)
      if (!statSync(cwd).isDirectory()) throw new TerminalError('Working directory must be a directory', 400)
      const session: Session = {
        ...input, cwd, agentId, id: `terminal-${randomUUID()}`, owner: principal,
        generation: 1, inputSequence: 0, state: 'running',
        ...this.startSize(principal, size),
        createdAt: this.now(), lastActivityAt: this.now(),
      }
      if ((input.checkout ?? (input.program === 'shell' ? 'existing' : 'isolated')) === 'isolated') {
        await this.sweepUnlocked()
        if (this.store.sessions().filter((s) => s.worktreePath).length >= (this.options.settings().maxWorktrees ?? 10)) throw new TerminalError('Retained worktree limit reached; review unfinished work before creating another')
        const result = await this.options.prepare({ repoPath: cwd, sessionId: session.id, agent: agentId ?? 'human' })
        if (!result?.ok || !result.worktreePath) throw new TerminalError(result?.error ?? 'Git session worktree support is unavailable', 503)
        session.cwd = result.worktreePath
        session.worktreePath = result.worktreePath
      }
      // Persist ownership before spawning so failed launches retain discoverable work.
      session.state = 'exited'
      this.save(session)
      await this.driver.create(session)
      session.state = 'running'
      this.save(session)
      // Unreconciled, the session stays detached; the first viewer sync retries.
      await this.attach(session)
      return session
    })
  }
  control(id: string, principal: Principal, operation: 'take' | 'return' | 'assign', agentId?: string): Promise<Session> {
    return this.run(async () => {
      if (principal.kind !== 'human') throw new TerminalError('Only the human can change control or assignment', 403)
      const session = this.get(id, principal)
      if (operation === 'assign') {
        if (agentId && !this.enabled().includes(agentId)) throw new TerminalError('Terminal is disabled for this agent', 403)
        session.agentId = agentId
        session.owner = principal
      } else if (operation === 'return') {
        authorize(session, principal, this.enabled(), true, session.generation)
        if (!session.agentId || !this.enabled().includes(session.agentId)) throw new TerminalError('No enabled agent is assigned')
        this.dropReservations(id)
        // The agent drives alone: terminal apps are detached first (Bakin's bridge and control clients stay).
        await this.detachNatives(id)
        session.owner = { kind: 'agent', id: session.agentId }
      } else session.owner = principal
      this.dropReservations(id)
      session.generation++
      session.inputSequence = 0
      session.lastActivityAt = this.now()
      this.save(session)
      return session
    })
  }
  write(id: string, principal: Principal, generation: number, sequence: number, data: string): Promise<Session> {
    return this.run(() => this.writeUnlocked(id, principal, generation, sequence, data))
  }
  /**
   * Viewer input: the server assigns the next sequence inside the queue, so
   * several writable viewers never collide on it. Agents keep `write`'s
   * explicit sequence.
   */
  writeNext(id: string, principal: Principal, generation: number, data: string): Promise<Session> {
    return this.run(() => this.writeUnlocked(id, principal, generation, this.get(id, principal).inputSequence + 1, data))
  }
  private async writeUnlocked(id: string, principal: Principal, generation: number, sequence: number, data: string): Promise<Session> {
    const session = this.get(id, principal)
    authorize(session, principal, this.enabled(), true, generation)
    if (session.state !== 'running') throw new TerminalError('Session has exited')
    if (sequence !== session.inputSequence + 1) throw new TerminalError('Input sequence is stale or out of order; do not retry ambiguous input')
    if (Buffer.byteLength(data) > 65536) throw new TerminalError('Input exceeds 64 KiB', 413)
    // No attachment (a resize could not be reconciled): refuse before consuming, so nothing is uncertain.
    if (!this.driver.connected(id)) throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    // Consume the sequence before delivery. A transport failure is never auto-retried.
    session.inputSequence = sequence
    session.lastActivityAt = this.now()
    this.save(session)
    try {
      await this.driver.write(id, data)
    } catch (error) {
      throw new DeliveryUncertainError(error instanceof Error ? error.message : String(error))
    }
    return session
  }
  /** Make `principal`'s screen the size authority and fit the grid to it (any human; spec D2). */
  claim(id: string, principal: Principal, cols: number, rows: number, claimant: SizeClaimant): Promise<Session> {
    return this.run(async () => {
      if (principal.kind !== 'human') throw new TerminalError('Only the human sizes terminal sessions', 403)
      const session = this.get(id, principal)
      if (session.state !== 'running') throw new TerminalError('Session has exited')
      Object.assign(session, claimSize(session, principal.id, claimant))
      const size = clampSize(cols, rows)
      return this.applySize(session, size.cols, size.rows)
    })
  }
  /** The authority's screen changed size: follow it. Anyone else, or an older epoch, is stale. */
  resizeAs(id: string, principal: Principal, epoch: number, cols: number, rows: number): Promise<Session> {
    return this.run(async () => {
      const session = this.get(id, principal)
      if (session.state !== 'running') throw new TerminalError('Session has exited')
      const next = nextSize(session, { viewer: principal.id, epoch, cols, rows })
      return this.applySize(session, next.cols, next.rows)
    })
  }
  /**
   * tmux first (the source of truth), then the bridge PTY, the headless
   * screen and the record. If tmux refuses, read back the window it actually
   * has and make everything else match. Runs inside the queue, so input
   * waits until the representations agree. When they cannot be made to
   * agree (tmux unreachable, the record unwritable), the attachment is
   * dropped: input is refused and viewers resync, and the next attachment
   * adopts tmux's actual window.
   */
  private async applySize(session: Session, cols: number, rows: number): Promise<Session> {
    try {
      let size = { cols, rows }
      if (cols !== session.cols || rows !== session.rows) {
        // A failed resize-window may still have moved the window; trust tmux.
        try { await this.driver.resize(session.id, cols, rows) }
        catch { size = await this.driver.windowSize(session.id) }
      }
      this.adoptSize(session, size)
      return session
    } catch {
      await this.stopScreen(session.id)
      throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    }
  }
  /** Make the headless screen and the record match `size` (tmux's window). */
  private adoptSize(session: Session, size: { cols: number; rows: number }): void {
    if (size.cols !== session.cols || size.rows !== session.rows) {
      this.screens.get(session.id)?.resize(size.cols, size.rows)
      session.cols = size.cols
      session.rows = size.rows
      session.sizeRevision++
    }
    this.save(session)
  }
  private startSize(principal: Principal, size?: StartSize): Pick<Session, 'cols' | 'rows' | 'sizeEpoch' | 'sizeRevision' | 'sizeAuthority'> {
    if (principal.kind === 'human' && size) {
      const { cols, rows, ...claimant } = size
      return { ...clampSize(cols, rows), sizeEpoch: 1, sizeRevision: 0, sizeAuthority: { viewer: principal.id, ...claimant } }
    }
    const fallback = this.options.settings().defaultSize ?? { cols: 200, rows: 60 }
    return { ...clampSize(fallback.cols, fallback.rows), sizeEpoch: 0, sizeRevision: 0 }
  }
  /**
   * Let one terminal app attach (spec D7): a single-use reservation bound to
   * this generation, confirmed by the launched tmux client's pid. Any client
   * that matches no reservation is detached, including a raw `tmux attach`.
   */
  reserveAttach(id: string, principal: Principal): Promise<{ session: Session; token: string; args: string[] }> {
    return this.run(async () => {
      if (principal.kind !== 'human') throw new TerminalError('Only the human attaches a terminal app', 403)
      const session = this.get(id, principal)
      if (session.state !== 'running') throw new TerminalError('Session has exited')
      if (session.owner.kind !== 'human') throw new TerminalError('An agent is driving this session. Take control first')
      // The control client must be watching before tmux attaches.
      await this.ensureAttached(session)
      const token = randomUUID()
      this.reservations.set(token, { sessionId: id, generation: session.generation, expires: this.now() + RESERVATION_MS })
      // Unconfirmed or unattached by then, it lapses and its waiting client (if any) is detached.
      const timer = setTimeout(() => { this.timers.delete(timer); this.clientsChanged(id) }, RESERVATION_MS + 50)
      this.timers.add(timer)
      return { session, token, args: this.driver.attachArgs(id) }
    })
  }
  /**
   * The launched client's pid. Resolves once that client is admitted, and
   * rejects when the reservation lapses first (expired, control changed, the
   * session ended), so the CLI never reports a terminal that was turned away.
   */
  async confirmAttach(token: string, pid: number): Promise<void> {
    const { admitted } = await this.run(async () => {
      const reservation = this.reservations.get(token)
      if (!reservation || reservation.pid !== undefined) throw new TerminalError('This attach is no longer valid; run the command again', 409)
      const session = this.store.sessions().find((entry) => entry.id === reservation.sessionId)
      if (reservation.expires < this.now()) {
        this.dropReservation(token)
        throw new TerminalError('This attach expired; run the command again', 409)
      }
      if (!session || session.generation !== reservation.generation || session.owner.kind !== 'human') {
        this.dropReservation(token)
        throw new TerminalError('Control changed; run the command again', 409)
      }
      reservation.pid = pid
      // Wrapped, not returned: the queue must not wait on admission (admission runs in the queue).
      const admitted = new Promise<void>((resolve, reject) => { reservation.settle = { resolve, reject } })
      admitted.catch(() => undefined)
      await this.reconcileClients(session.id)
      return { admitted }
    })
    await admitted
  }
  /** The terminal apps admitted to a session right now. */
  nativeClients(id: string): NativeClient[] { return [...this.natives.get(id)?.values() ?? []] }
  /** Hear when a terminal app is admitted, resizes, or leaves. */
  onNatives(id: string, listener: () => void): () => void {
    let listeners = this.nativeListeners.get(id)
    if (!listeners) this.nativeListeners.set(id, listeners = new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.nativeListeners.delete(id)
    }
  }
  /** tmux saw a client attach, resize or leave: reconcile once in the queue (repeat signals coalesce). */
  private clientsChanged(id: string): void {
    if (this.closed || this.reconciling.has(id)) return
    this.reconciling.add(id)
    void this.run(async () => {
      this.reconciling.delete(id)
      await this.reconcileClients(id)
    }).catch(() => undefined)
  }
  /**
   * Admit clients with a confirmed reservation, hold terminal clients
   * (read-only) while a reservation waits for its confirm, detach everything
   * else — a foreign control-mode client always, since read-only does not
   * stop its commands — and follow the app that sizes the session. Runs in
   * the queue. A client that leaves mid-way is skipped; other failures throw.
   */
  private async reconcileClients(id: string): Promise<void> {
    const session = this.store.sessions().find((entry) => entry.id === id)
    if (!session || session.state !== 'running') { this.forgetNatives(id); return }
    for (const [token, reservation] of this.reservations) {
      if (reservation.expires < this.now()) this.dropReservation(token, 'This attach expired; run the command again')
    }
    const admitted = this.natives.get(id) ?? new Map<number, NativeClient>()
    const next = new Map<number, NativeClient>()
    let newest: NativeClient | undefined
    const present = await this.driver.clients(id)
    for (const client of present) {
      if (admitted.has(client.pid)) { next.set(client.pid, client); continue }
      const match = client.control ? undefined : [...this.reservations].find(([, reservation]) => reservation.sessionId === id && reservation.pid === client.pid && reservation.generation === session.generation)
      if (match && session.owner.kind === 'human') {
        // Launched read-only; admitted, it types.
        if (!await this.onClient(id, client, () => this.driver.setReadonly(id, client, false))) continue
        next.set(client.pid, { ...client, readonly: false })
        newest = client
        this.dropReservation(match[0])
        continue
      }
      const pending = [...this.reservations.values()].some((reservation) => reservation.sessionId === id && reservation.pid === undefined)
      // A confirm is on its way: hold the terminal client, unable to type, until then.
      if (pending && !client.control) await this.onClient(id, client, () => this.driver.setReadonly(id, client, true))
      else await this.onClient(id, client, () => this.driver.detachClient(client.name))
    }
    const changed = next.size !== admitted.size || [...next].some(([pid, client]) => {
      const before = admitted.get(pid)
      return !before || before.cols !== client.cols || before.rows !== client.rows
    })
    this.natives.set(id, next)
    // The newest admitted app claims the size; the app holding the claim is followed.
    if (newest) Object.assign(session, claimSize(session, nativeViewer(newest.pid), { kind: 'native' }))
    const authority = session.sizeAuthority
    const sizer = authority?.kind === 'native' ? [...next.values()].find((client) => nativeViewer(client.pid) === authority.viewer) : undefined
    if (sizer) {
      const size = clampSize(sizer.cols, sizer.rows)
      await this.applySize(session, size.cols, size.rows)
    } else if (newest) this.save(session)
    if (changed) for (const listener of this.nativeListeners.get(id) ?? []) listener()
  }
  /** Act on one client; false when it left meanwhile (tmux no longer lists it). Anything else is a real failure. */
  private async onClient(id: string, client: NativeClient, action: () => Promise<void>): Promise<boolean> {
    try {
      await action()
      return true
    } catch (error) {
      if ((await this.driver.clients(id)).some((entry) => entry.pid === client.pid)) throw error
      return false
    }
  }
  /** Spend or revoke a reservation; a waiting confirm learns the outcome. */
  private dropReservation(token: string, refused?: string): void {
    const reservation = this.reservations.get(token)
    if (!reservation) return
    this.reservations.delete(token)
    if (refused) reservation.settle?.reject(new TerminalError(refused, 409))
    else reservation.settle?.resolve()
  }
  private dropReservations(id: string, refused = 'Control changed; run the command again'): void {
    for (const [token, reservation] of this.reservations) if (reservation.sessionId === id) this.dropReservation(token, refused)
  }
  /** Detach every client that is not Bakin's own (admitted or held) and wait until tmux reports them gone. */
  private async detachNatives(id: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const remaining = await this.driver.clients(id)
      if (!remaining.length) break
      if (attempt >= 40) throw new TerminalError('A terminal app is still attached; close it and try again', 503)
      // One that already left is fine: the next listing decides.
      if (attempt % 10 === 0) for (const client of remaining) await this.driver.detachClient(client.name).catch(() => undefined)
      await Bun.sleep(50)
    }
    this.forgetNatives(id)
  }
  /** The session no longer has terminal apps (detached, ended or deleted): drop its admission state. */
  private forgetNatives(id: string): void {
    this.dropReservations(id, 'The session changed; run the command again')
    const had = this.natives.get(id)?.size
    this.natives.delete(id)
    if (had) for (const listener of this.nativeListeners.get(id) ?? []) listener()
  }
  finish(id: string, principal: Principal, _generation: number, terminate: boolean): Promise<Session> {
    return this.run(async () => {
      // Lifecycle, not input: get() already gates access (a human is the
      // operator; an agent sees only its own session). Ending a session never
      // needed to be the live input owner, so the operator can stop an agent's
      // runaway session without seizing keyboard control first.
      const session = this.get(id, principal)
      if (session.state === 'completed') return session
      const alive = await this.driver.alive(id)
      if (alive && !terminate) throw new TerminalError('The process is still running; exit it or explicitly terminate it first')
      await this.driver.terminate(id)
      await this.stopScreen(id)
      this.forgetNatives(id)
      session.state = 'completed'
      session.completedAt = this.now()
      this.save(session)
      await this.clean(session)
      return session
    })
  }
  async screen(id: string, principal: Principal): Promise<{ session: Session; data: string; cursor: number }> {
    const screen = await this.ensureScreen(id, principal)
    const snapshot = await screen.capture(() => ({ data: screen.serialize(), cursor: this.store.output(id, Number.MAX_SAFE_INTEGER).cursor }))
    const current = this.get(id, principal)
    return { session: current, ...snapshot }
  }
  /** The visible pane as text, with the grid it was read at (captured together). */
  async readScreen(id: string, principal: Principal): Promise<{ screen: string; cols: number; rows: number; sizeRevision: number }> {
    const screen = await this.ensureScreen(id, principal)
    return screen.capture(() => {
      const session = this.get(id, principal)
      return { screen: screen.text(), cols: session.cols, rows: session.rows, sizeRevision: session.sizeRevision }
    })
  }
  /** One bounded page of stored output after `cursor`, as bytes (at least one stored chunk, else at most `limit` bytes). */
  outputPage(id: string, principal: Principal, cursor: number, limit?: number): { session: Session; cursor: number; data: Buffer; truncated: boolean } {
    const session = this.get(id, principal)
    if (session.state === 'running' && (!this.driver.connected(id) || this.screens.get(id)?.failed)) throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    return { session, ...this.store.output(id, cursor, limit) }
  }
  output(id: string, principal: Principal, cursor: number) {
    const page = this.outputPage(id, principal, cursor)
    return { ...page, data: page.data.toString('base64') }
  }
  deleteHistory(id: string, principal: Principal): Promise<void> {
    return this.run(() => this.deleteHistoryUnlocked(id, principal))
  }
  private async deleteHistoryUnlocked(id: string, principal: Principal): Promise<void> {
    if (principal.kind !== 'human') throw new TerminalError('Only the human can delete history', 403)
    const session = this.get(id, principal)
    if (session.state !== 'completed') throw new TerminalError('Complete the session before deleting history')
    await this.stopScreen(id)
    this.store.deleteOutput(id)
    session.historyDeleted = true
    this.save(session)
  }
  deleteSession(id: string, principal: Principal): Promise<void> {
    return this.run(async () => {
      if (principal.kind !== 'human') throw new TerminalError('Only the human can delete a session', 403)
      const session = this.get(id, principal)
      // The operator can always delete an ended session — no exceptions. A live
      // process is the only wall (end it first). A retained worktree is torn
      // down best-effort (force-removing the checkout keeps its branch); a
      // git failure never blocks removing the session record.
      if (session.state === 'running') throw new TerminalError('End the session before deleting it')
      if (session.worktreePath) {
        await this.options.release({ sessionId: session.id, worktreePath: session.worktreePath, teardown: true }).catch(() => undefined)
      }
      await this.stopScreen(id)
      this.forgetNatives(id)
      this.store.deleteSession(id)
    })
  }
  private async clean(session: Session): Promise<void> {
    if (!session.worktreePath || session.state !== 'completed') return
    if (this.store.sessions().some((s) => {
      const path = relative(session.worktreePath!, s.cwd)
      return s.state === 'running' && (!path || (!path.startsWith('..') && !isAbsolute(path)))
    }) || await this.driver.inUse(session.worktreePath)) {
      session.cleanupReason = 'Worktree is still in use'
    } else {
      const result = await this.options.release({ sessionId: session.id, worktreePath: session.worktreePath }).catch(() => ({ ok: false, error: 'Git cleanup failed; worktree retained for review' }))
      if (result?.ok) { delete session.worktreePath; delete session.cleanupReason }
      else session.cleanupReason = result?.error ?? 'Git cleanup could not be verified'
    }
    this.save(session)
  }
  private async sweepUnlocked(): Promise<void> {
    for (const session of this.store.sessions()) {
      if (this.now() - session.lastActivityAt >= (this.options.settings().idleDays ?? 30) * DAY) {
        if (session.state === 'exited') {
          await this.driver.terminate(session.id)
          await this.stopScreen(session.id)
          session.state = 'completed'
          session.completedAt = this.now()
          this.save(session)
        }
      }
      if (session.state === 'completed') await this.clean(session)
      if (session.completedAt !== undefined && this.now() - session.completedAt >= 30 * DAY && !session.historyDeleted) await this.deleteHistoryUnlocked(session.id, { kind: 'human', id: 'maintenance' })
    }
  }
  sweep(): Promise<void> { return this.run(() => this.sweepUnlocked()) }
  /**
   * Set up (or update) the tmux service in the manager's queue, so it can
   * never land in the middle of a session's creation, then reattach.
   */
  setupService(install: () => Promise<void>): Promise<void> {
    return this.run(async () => {
      await install()
      for (const session of this.store.sessions()) {
        if (session.state !== 'running') continue
        if (await this.driver.alive(session.id)) {
          await this.driver.title(session)
          // Unreconciled, the session stays detached; the first viewer sync retries.
          await this.attach(session)
        } else { session.state = 'exited'; this.save(session) }
      }
    })
  }
  async beforeUninstall(stop: () => Promise<void>): Promise<void> {
    await this.run(async () => {
      if (this.store.sessions().some((s) => s.state !== 'completed' || s.worktreePath)) throw new TerminalError('Complete sessions and review retained worktrees before removing Terminal')
      await stop()
      this.closed = true
    })
  }
  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const token of [...this.reservations.keys()]) this.dropReservation(token, 'Terminal is shutting down')
    await this.pending
    this.closed = true
    await this.driver.detach()
    for (const screen of this.screens.values()) { await screen.drain(); screen.close() }
    this.screens.clear()
    this.store.close()
  }
}
