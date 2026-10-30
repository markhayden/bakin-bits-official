import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { authorize, createSchema, DAY, DeliveryUncertainError, TerminalError, type CreateInput, type Principal, type Session, type SizeClaimant, type TerminalSettings } from './contracts'
import type { NativeClient, ProcessDriver, WriteOptions } from './processes'
import { claimSize, clampSize, nextSize } from './sizing'
import type { Fidelity, RawSource } from './raw-display'
import { Store } from './store'
import { makeBundle, type Bundle } from './bundle'
import { visibleText } from './terminal-state'
import { bufferText } from './buffer-text'
import { bundleText } from './bundle-text'

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
/** Tell every listener; one that throws never stops the rest or the caller's bookkeeping. */
function notify<T>(listeners: Iterable<T> | undefined, call: (listener: T) => void): void {
  for (const listener of listeners ?? []) {
    try { call(listener) } catch { /* a viewer's failure is its own (it rejoins) */ }
  }
}
/** The creating screen's grid and what kind of screen it is (it holds the size claim). */
export type StartSize = { cols: number; rows: number } & SizeClaimant

export interface SessionOptions {
  settings(): TerminalSettings
  prepare(input: { repoPath: string; sessionId: string; agent: string }): Promise<WorktreeResult | undefined>
  release(input: { sessionId: string; worktreePath: string; teardown?: boolean }): Promise<WorktreeResult | undefined>
  validateLinks?(input: CreateInput): Promise<void>
  now?(): number
  log?: { info(message: string, data?: Record<string, unknown>): void }
}

/** How long an ending session's final picture may take (a drain, or a rebuild's seed) before its output is recorded as not saved. */
export const FINAL_CUT_MS = 3000

export class Sessions {
  private pending: Promise<unknown> = Promise.resolve()
  private sessionListeners = new Map<string, Set<(session: Session) => void>>()
  private reservations = new Map<string, Reservation>()
  /** Admitted terminal apps by session, keyed by tmux client pid. */
  private natives = new Map<string, Map<number, NativeClient>>()
  private nativeListeners = new Map<string, Set<() => void>>()
  private reconciling = new Set<string>()
  /** Final-output saves in progress, one per session (plan T35b). */
  private ending = new Map<string, Promise<void>>()
  /** Every finish outstanding, by session, from its reservation to its kill: input is refused, startup's bundle rule skips them. */
  private finishing = new Map<string, Set<Promise<void>>>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  /** Sessions this manager has attached (its control client asked for), until detached: attach runs once per session. */
  private attached = new Set<string>()
  private closed = false
  constructor(readonly store: Store, private driver: ProcessDriver, private options: SessionOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now() }
  /** Persist and tell live viewers (ownership, size and state reach them at once). */
  private save(session: Session): void {
    this.store.save(session)
    notify(this.sessionListeners.get(session.id), (listener) => listener(session))
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
  /**
   * The manager's queue. Once shutdown starts, a new submission is refused at once; `continuing` is
   * for the next step of work already accepted (a finish's kill, a refresh's liveness pass), which
   * shutdown drains.
   */
  private run<T>(work: () => Promise<T>, continuing = false): Promise<T> {
    if (this.stopping && !continuing) return Promise.reject(new TerminalError('Terminal manager is shutting down', 503))
    const next = this.pending.then(() => { if (this.closed) throw new TerminalError('Terminal manager is shutting down', 503); return work() })
    this.pending = next.catch(() => {})
    return next
  }
  /** What live sessions hold in this process (lib/memory.ts): replicas and their logs. Steps: run it sliced. */
  *retainedSteps(): Generator<void, number> {
    return this.driver.retainedSteps ? yield* this.driver.retainedSteps() : 0
  }
  /** Periodic upkeep of live sessions' emulators (link orphans erased since their last sweep). */
  async maintainEmulators(): Promise<void> {
    await this.driver.maintain?.()
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
  start(): Promise<void> { return this.setupService(async () => {}, { startup: true }) }
  /**
   * tmux says a pane died: one refresh at a time, and one more after it when
   * hints came meanwhile (a refresh that already checked a session may have
   * missed its death), never one per hint.
   */
  private paneDied(): void {
    // Shutting down: a hint only marks that a refresh is owed; shutdown runs one last one itself, so
    // endless hints cannot hold it open and a death meanwhile is still saved.
    if (this.stopping) { this.owedAtStop = true; return }
    this.requestRefresh()
  }
  private owedAtStop = false
  private requestRefresh(): void {
    if (this.refreshing) { this.refreshAgain = true; return }
    this.refreshing = this.trackRefresh().catch(() => undefined).finally(() => {
      this.refreshing = undefined
      if (!this.refreshAgain || this.closed) return
      this.refreshAgain = false
      // Owed when shutdown began: shutdown's own last refresh covers it.
      if (this.stopping) this.owedAtStop = true; else this.requestRefresh()
    })
  }
  private refreshing: Promise<void> | undefined
  private refreshAgain = false
  private stopping = false
  refreshStates(): Promise<void> {
    // Shutting down: no new lifecycle work is taken (shutdown runs its own last refresh).
    if (this.stopping) return Promise.reject(new TerminalError('Terminal is shutting down', 503))
    return this.trackRefresh()
  }
  private trackRefresh(): Promise<void> {
    // Tracked from its call: its saves start after its queue turn, and shutdown waits for them.
    const work = this.refreshOnce()
    const settled = work.then(() => undefined, () => undefined)
    this.refreshes.add(settled)
    void settled.then(() => this.refreshes.delete(settled))
    return work
  }
  private refreshes = new Set<Promise<void>>()
  private async refreshOnce(): Promise<void> {
    const saving = await this.run(async () => {
      const saves: Promise<void>[] = []
      for (const session of this.store.sessions()) {
        if (session.state === 'running' && !await this.driver.alive(session.id)) saves.push(this.publishExit(session))
      }
      return saves
    }, true)
    await Promise.all(saving)
  }
  /**
   * Attach and adopt tmux's actual window before anything reads or writes
   * through the attachment (the record may be stale: a resize whose save
   * failed, a crash). False when tmux cannot say: the attachment is dropped
   * again, and the next join or read retries.
   */
  private async attach(session: Session): Promise<boolean> {
    this.attachUnreconciled(session)
    try {
      this.adoptSize(session, await this.driver.windowSize(session.id))
    } catch {
      await this.detach(session.id)
      return false
    }
    // Terminal apps already attached (one left over from before a restart, or
    // an attach while nobody watched) meet the same admission check.
    await this.reconcileClients(session.id).catch(() => undefined)
    return true
  }
  /** Once per session until it is detached: a second attach would be a second control client (and a fake recovery). */
  private attachUnreconciled(session: Session): void {
    if (this.attached.has(session.id)) return
    this.attached.add(session.id)
    this.driver.attach(session, () => this.clientsChanged(session.id), () => this.paneDied())
  }
  private async detach(id: string): Promise<void> {
    this.attached.delete(id)
    await this.driver.detach(id)
  }
  private async ensureAttached(session: Session): Promise<void> {
    if (session.state !== 'running') throw new TerminalError('Live terminal screen unavailable', 503)
    // The session's source is its replica (spec D13): its control client closed or its replica ended (a
    // failed reseed) is a loss, recovered by attaching again.
    if (!this.replicaLive(session.id)) {
      await this.detach(session.id)
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
      // A confirmed service update owns the live set from its check to its setup.
      if (this.updatingService) throw new TerminalError('Terminal is applying its service update; start the session again in a moment.', 409)
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
        // Its final output is a bundle once it ends (plan T35b); a crash before that leaves this false.
        outputSaved: false,
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
      // Unreconciled, the session stays detached; the first join or read retries.
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
        // The agent drives alone: terminal apps are detached first (Bakin's control client stays).
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
  writeNext(id: string, principal: Principal, generation: number, data: string, options: WriteOptions = {}): Promise<Session> {
    return this.run(() => this.writeUnlocked(id, principal, generation, this.get(id, principal).inputSequence + 1, data, options))
  }
  private async writeUnlocked(id: string, principal: Principal, generation: number, sequence: number, data: string, options: WriteOptions = {}): Promise<Session> {
    const session = this.get(id, principal)
    authorize(session, principal, this.enabled(), true, generation)
    if (session.state !== 'running') throw new TerminalError('Session has exited')
    // Its final picture is being taken: nothing typed now could be in it.
    if (this.ending.has(id) || this.finishing.has(id)) throw new TerminalError('Session is ending', 409)
    if (sequence !== session.inputSequence + 1) throw new TerminalError('Input sequence is stale or out of order; do not retry ambiguous input')
    // The Return of a Paste + Enter counts too.
    if (Buffer.byteLength(data) + (options.paste && options.enter ? 1 : 0) > 65536) throw new TerminalError('Input exceeds 64 KiB', 413)
    // No attachment (a resize could not be reconciled): refuse before consuming, so nothing is uncertain.
    // Input health is the control client's (spec D13).
    if (!this.driver.connected(id)) throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    // Consume the sequence before delivery. A transport failure is never auto-retried.
    session.inputSequence = sequence
    session.lastActivityAt = this.now()
    this.save(session)
    try {
      await this.driver.write(id, data, options)
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
   * tmux first (the source of truth), then the record. If tmux refuses, read back the window it actually
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
      await this.detach(session.id)
      throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    }
  }
  /** Make the record match `size` (tmux's window). */
  private adoptSize(session: Session, size: { cols: number; rows: number }): void {
    if (size.cols !== session.cols || size.rows !== session.rows) {
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
      // Unspent by then it lapses (whatever the clock says), and its waiting client (if any) is detached.
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        void this.run(async () => {
          this.dropReservation(token, 'This attach expired; run the command again')
          await this.reconcileClients(id)
        }).catch(() => undefined)
      }, RESERVATION_MS)
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
      try { await this.reconcileClients(session.id) }
      catch (error) {
        // Not admitted by the failed pass: say so instead of waiting out the expiry.
        this.dropReservation(token, `Could not admit this terminal: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { admitted }
    })
    await admitted
  }
  /** The session's replica while attached. */
  replica(id: string): RawSource | undefined { return this.driver.replica?.(id) }
  private replicaLive(id: string): boolean {
    return this.driver.connected(id) && Boolean(this.driver.replica?.(id))
  }
  /**
   * A raw join's first step: the session attached, its replica live (one lost is rebuilt from tmux: a
   * recovery). A live one is the common case and waits for nothing; a recovery takes the manager's
   * queue, as every attachment does (input to other sessions waits behind it meanwhile).
   */
  ensureReplica(id: string, principal: Principal): Promise<void> {
    if (this.get(id, principal).state === 'running' && this.replicaLive(id)) return Promise.resolve()
    return this.run(async () => { await this.ensureAttached(this.get(id, principal)) })
  }
  /**
   * A viewer's picture repeatedly differed from the replica's (plan T37): the
   * replica is rebuilt from tmux, and that is logged with positions and
   * counts — never the screen's contents (terminal output can hold secrets).
   */
  diverged(id: string, detail: { category: string; seq: number; mismatches: number }): void {
    this.options.log?.info('Terminal display diverged; rebuilding from tmux', { sessionId: id, ...detail })
    void this.driver.replica?.(id)?.diverged().catch(() => undefined)
  }
  /** An ended session's saved final output, read across turns (undefined: none, or unreadable). */
  bundle(id: string): Promise<Bundle | undefined> { return this.store.bundle(id) }
  /** The rebuilds the session's output has been through. */
  fidelity(id: string): Fidelity { return this.driver.fidelity?.(id) ?? { rebuilds: {} } }
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
    const present = await this.driver.clients(id)
    // Admitted clients still attached stay admitted whatever happens below.
    const next = new Map(present.filter((client) => admitted.has(client.pid)).map((client) => [client.pid, client]))
    const fresh: Array<{ client: NativeClient; token: string }> = []
    // One client failing never stops the others (or the sizing below); the first failure is rethrown at the end.
    let failure: unknown
    for (const client of present) {
      if (admitted.has(client.pid)) continue
      try {
        const match = client.control ? undefined : [...this.reservations].find(([, reservation]) => reservation.sessionId === id && reservation.pid === client.pid && reservation.generation === session.generation)
        if (match && session.owner.kind === 'human') {
          // Admitted below, once its claim and size are in place; it stays read-only (as launched) until then.
          if (!client.readonly && !await this.onClient(id, client, () => this.driver.setReadonly(id, client, true))) continue
          fresh.push({ client: { ...client, readonly: true }, token: match[0] })
          continue
        }
        const pending = [...this.reservations.values()].some((reservation) => reservation.sessionId === id && reservation.pid === undefined)
        // A confirm is on its way: hold the terminal client, unable to type, until then.
        if (pending && !client.control) await this.onClient(id, client, () => this.driver.setReadonly(id, client, true))
        else await this.onClient(id, client, () => this.driver.detachClient(client.name))
      } catch (error) { failure ??= error }
    }
    const newest = fresh.at(-1)?.client
    const admittedTokens: string[] = []
    if (newest) {
      // The newest admitted app claims the size and the session takes it on.
      // Claim, record and resize succeed together, or every fresh admission is revoked.
      let sized = false
      try {
        Object.assign(session, claimSize(session, nativeViewer(newest.pid), { kind: 'native' }))
        const size = clampSize(newest.cols, newest.rows)
        await this.applySize(session, size.cols, size.rows)
        sized = true
      } catch (error) {
        failure ??= error
        for (const { client, token } of fresh) {
          await this.driver.detachClient(client.name).catch(() => undefined)
          this.dropReservation(token, `Could not admit this terminal: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // Only now can they type, each on its own: one leaving never costs another its admission.
      if (sized) for (const { client, token } of fresh) {
        try {
          if (await this.onClient(id, client, () => this.driver.setReadonly(id, client, false))) {
            next.set(client.pid, { ...client, readonly: false })
            admittedTokens.push(token)
          } else this.dropReservation(token, 'This terminal left before it was admitted; run the command again')
        } catch (error) {
          failure ??= error
          await this.driver.detachClient(client.name).catch(() => undefined)
          this.dropReservation(token, `Could not admit this terminal: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else {
      // The admitted app holding the claim is followed. If tmux and the record
      // cannot be made to agree, applySize drops Bakin's attachment (the
      // next one adopts tmux's window); the app itself is attached to tmux.
      const authority = session.sizeAuthority
      const sizer = authority?.kind === 'native' ? [...next.values()].find((client) => nativeViewer(client.pid) === authority.viewer) : undefined
      if (sizer) {
        const size = clampSize(sizer.cols, sizer.rows)
        try { await this.applySize(session, size.cols, size.rows) } catch (error) { failure ??= error }
      }
    }
    // Recorded first, then the confirms learn they were admitted.
    this.natives.set(id, next)
    for (const token of admittedTokens) this.dropReservation(token)
    const changed = next.size !== admitted.size || [...next].some(([pid, client]) => {
      const before = admitted.get(pid)
      return !before || before.cols !== client.cols || before.rows !== client.rows
    })
    if (changed) notify(this.nativeListeners.get(id), (listener) => listener())
    if (failure !== undefined) throw failure
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
    if (had) notify(this.nativeListeners.get(id), (listener) => listener())
  }
  finish(id: string, principal: Principal, generation: number, terminate: boolean): Promise<Session> {
    if (this.stopping) return Promise.reject(new TerminalError('Terminal is shutting down', 503))
    const operation = this.finishOnce(id, principal, generation, terminate)
    // Held from before the reservation (set synchronously) until the kill is done, and until every
    // finish of the session settles: nothing reaches the program between its final picture and its end.
    const held = operation.then(() => undefined, () => undefined)
    const all = this.finishing.get(id) ?? new Set<Promise<void>>()
    this.finishing.set(id, all)
    all.add(held)
    void held.then(() => { all.delete(held); if (!all.size && this.finishing.get(id) === all) this.finishing.delete(id) })
    return operation
  }
  private async finishOnce(id: string, principal: Principal, _generation: number, terminate: boolean): Promise<Session> {
    // Lifecycle, not input: get() already gates access (a human is the
    // operator; an agent sees only its own session). Ending a session never
    // needed to be the live input owner, so the operator can stop an agent's
    // runaway session without seizing keyboard control first.
    // Reserved in the queue (input to it is refused from here), saved outside it (bounded by
    // FINAL_CUT_MS); a failed save never blocks the kill (a retained pane leaks).
    const reserved = await this.run(async () => {
      const session = this.get(id, principal)
      if (session.state === 'completed') return { done: session }
      if (await this.driver.alive(id) && !terminate) throw new TerminalError('The process is still running; exit it or explicitly terminate it first')
      return { saving: this.saveFinal(id) }
    })
    if (reserved.done) return reserved.done
    await reserved.saving
    return this.run(async () => {
      const session = this.get(id, principal)
      if (session.state === 'completed') return session
      try {
        await this.driver.terminate(id)
      } catch (error) {
        // The kill failed and the program runs on: what was saved is not its final output.
        if (await this.driver.alive(id).catch(() => true) && this.store.hasBundle(id)) this.store.discardProvisionalBundle(id)
        throw error
      }
      await this.detach(id)
      this.forgetNatives(id)
      session.state = 'completed'
      session.completedAt = this.now()
      this.save(session)
      await this.clean(session)
      return session
    }, true)
  }
  /**
   * Persist an ending session's final output (plan T35b): the replica's
   * picture after a drain (to a control reply while the control client is
   * connected), bounded by FINAL_CUT_MS, committed with the session's flag
   * and any evictions in one transaction (lib/store.ts). Outside the manager
   * queue, one at a time per session. Never throws: no picture in time, or a
   * failed write, is `outputSaved: false`.
   */
  private saveFinal(id: string): Promise<void> {
    const running = this.ending.get(id)
    if (running) return running
    // Registered at once: a caller in the queue reserves the session before it leaves the queue.
    const work = this.saveFinalOnce(id).finally(() => this.ending.delete(id))
    this.ending.set(id, work)
    return work
  }
  /**
   * A running session's program exited (in the queue): its final save is
   * registered before the exit is published, so a viewer that joins the
   * ended session waits for it (`finalSaved`). The pane stays
   * (remain-on-exit): what the program printed last is in the replica.
   */
  private publishExit(session: Session): Promise<void> {
    const saving = this.saveFinal(session.id)
    session.state = 'exited'
    this.forgetNatives(session.id)
    this.save(session)
    return saving
  }
  /** Settles once the session's final save in flight, if any, has: its record then says whether it was saved. */
  finalSaved(id: string): Promise<void> {
    return this.ending.get(id) ?? Promise.resolve()
  }
  /** Best effort: the failure is recorded when it can be, and never stops what follows (a kill). */
  private markNotSaved(id: string): void {
    try { this.store.markOutput(id, false) } catch (error) {
      this.options.log?.info('Terminal could not record that output was not saved', { sessionId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  private async saveFinalOnce(id: string): Promise<void> {
    if (this.store.session(id)?.outputSaved) return
    let evicted: string[] = []
    try {
      const cut = await this.driver.finalCut?.(id, { boundary: this.driver.connected(id), timeoutMs: FINAL_CUT_MS })
      if (cut) ({ evicted } = await this.store.saveBundle(id, makeBundle(cut, this.fidelity(id), this.now())))
      else this.markNotSaved(id)
    } catch (error) {
      this.options.log?.info('Terminal final output was not saved', { sessionId: id, error: error instanceof Error ? error.message : String(error) })
      this.markNotSaved(id)
    }
    // The store set the flags; viewers hear the records as they are now (evicted ones included).
    for (const changed of [id, ...evicted]) {
      const session = this.closed ? undefined : this.store.session(changed)
      if (session) notify(this.sessionListeners.get(changed), (listener) => listener(session))
    }
  }
  /**
   * The visible pane as text, with the grid it was read at — all of it from
   * the replica in one step: its screen, its dimensions and its size
   * revision (spec D3, plan T34a).
   */
  async readScreen(id: string, principal: Principal): Promise<{ screen: string; cols: number; rows: number; sizeRevision: number }> {
    const replica = await this.run(async () => {
      await this.ensureAttached(this.get(id, principal))
      return this.driver.replica?.(id)
    })
    // Access is checked again once the read runs: a reassignment while it waited revokes it.
    const view = await replica?.read((terminal) => {
      this.get(id, principal)
      return { screen: visibleText(terminal), cols: terminal.cols, rows: terminal.rows, sizeRevision: replica.sizeRevision }
    })
    if (!view) throw new TerminalError('Terminal output is not ready yet; retry', 503)
    return view
  }
  /**
   * The session's text, history and screen, as plain lines (the agent tool's
   * `output`): the replica's while it runs, its saved final picture once it
   * ended. `lines` keeps the last that many.
   */
  async outputText(id: string, principal: Principal, lines?: number): Promise<{ session: Session; text: string; lines: number; truncated: boolean }> {
    const session = this.get(id, principal)
    let read: { text: string; lines: number } | undefined
    if (session.state === 'running') {
      const replica = await this.run(async () => {
        await this.ensureAttached(this.get(id, principal))
        return this.driver.replica?.(id)
      })
      read = await replica?.read((terminal) => { this.get(id, principal); return bufferText(terminal.buffer.active) })
      if (!read) throw new TerminalError('Terminal output is not ready yet; retry', 503)
    } else {
      const bundle = await this.store.bundle(id)
      if (!bundle) throw new TerminalError(session.historyDeleted ? 'This session\'s output was deleted' : 'This session ended without its output being saved', 404)
      read = await bundleText(bundle)
    }
    const all = read.text ? read.text.split('\n') : []
    const kept = lines !== undefined && all.length > lines ? all.slice(-lines) : all
    return { session: this.get(id, principal), text: kept.join('\n'), lines: kept.length, truncated: kept.length < all.length }
  }
  deleteHistory(id: string, principal: Principal): Promise<void> {
    return this.run(() => this.deleteHistoryUnlocked(id, principal))
  }
  private async deleteHistoryUnlocked(id: string, principal: Principal): Promise<void> {
    if (principal.kind !== 'human') throw new TerminalError('Only the human can delete history', 403)
    const session = this.get(id, principal)
    if (session.state !== 'completed') throw new TerminalError('Complete the session before deleting history')
    await this.detach(id)
    this.store.deleteBundle(id)
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
      await this.detach(id)
      this.forgetNatives(id)
      this.driver.forget?.(id)
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
        // Not while its final save is in flight (sweep() tries a failed one again first).
        if (session.state === 'exited' && !this.ending.has(session.id)) {
          await this.driver.terminate(session.id)
          await this.detach(session.id)
          session.state = 'completed'
          session.completedAt = this.now()
          this.save(session)
        }
      }
      if (session.state === 'completed') await this.clean(session)
      if (session.completedAt !== undefined && this.now() - session.completedAt >= 30 * DAY && !session.historyDeleted) await this.deleteHistoryUnlocked(session.id, { kind: 'human', id: 'maintenance' })
    }
  }
  sweep(): Promise<void> {
    if (this.stopping) return Promise.reject(new TerminalError('Terminal is shutting down', 503))
    // Accepted: it runs to its end, and shutdown waits for it.
    const work = this.sweepOnce()
    const settled = work.then(() => undefined, () => undefined)
    this.sweeps.add(settled)
    void settled.then(() => this.sweeps.delete(settled))
    return work
  }
  private sweeps = new Set<Promise<void>>()
  private async sweepOnce(): Promise<void> {
    // An exited session whose final output is not saved yet (a failed save) tries again before
    // maintenance may complete it: every retry reserved at once (in the queue, attached to its
    // retained pane if nothing is), then saved outside it.
    const retries = await this.run(async () => {
      const saves: Promise<void>[] = []
      for (const session of this.store.sessions()) {
        if (session.state !== 'exited' || session.outputSaved !== false) continue
        // An unusable attachment (its control client closed, or its replica ended) is replaced: a new one
        // seeds a replica from the pane.
        if (!this.replicaLive(session.id)) await this.detach(session.id)
        this.attachUnreconciled(session)
        saves.push(this.saveFinal(session.id))
      }
      return saves
    }, true)
    await Promise.all(retries)
    return this.run(() => this.sweepUnlocked(), true)
  }
  /**
   * Set up (or update) the tmux service in the manager's queue, so it can
   * never land in the middle of a session's creation, then reattach.
   */
  async setupService(install: () => Promise<void>, options: { startup?: boolean } = {}): Promise<void> {
    const saving = await this.run(async () => {
      await install()
      const saves: Promise<void>[] = []
      for (const session of this.store.sessions()) {
        if (session.state !== 'running') continue
        if (await this.driver.alive(session.id)) {
          // Alive with a bundle: it was saved, then a crash came before the kill; the session goes on. (A
          // pane that died meanwhile keeps its bundle: that was its final output.)
          // Only at startup: on a live server, a running session with a bundle is a finish between its save
          // and its kill.
          if (options.startup && !this.finishing.has(session.id) && this.store.hasBundle(session.id)) this.store.discardProvisionalBundle(session.id)
          await this.driver.title(session)
          // Unreconciled, the session stays detached; the first join or read retries.
          await this.attach(session)
        } else {
          // Its program exited while nothing watched (a restart): attached to its retained pane, its
          // replica seeds from it, so the final save still has the last screen.
          this.attachUnreconciled(session)
          saves.push(this.publishExit(session))
        }
      }
      return saves
    })
    await Promise.all(saving)
  }
  /**
   * The service update a person confirmed (Terminal's Apply update): the
   * live sessions they were shown end, then the service is set up. Refused,
   * ending nothing, when no update is due any more or the live sessions are
   * no longer exactly the confirmed ones. A session that cannot be ended
   * stops it there (no setup), and the error names what did end.
   */
  async applyServiceUpdate(confirmed: string[], principal: Principal, install: () => Promise<void>, required: () => Promise<boolean>): Promise<{ ended: string[] }> {
    // Checked in the queue (a creation in flight has landed by then), and reserved until setup is done:
    // no session starts in between.
    const live = await this.run(async () => {
      if (this.updatingService) throw new TerminalError('The Terminal service update is already being applied.', 409)
      if (!await required()) throw new TerminalError('The Terminal service is already up to date; no sessions were ended.', 409)
      const running = this.store.sessions().filter((session) => session.state === 'running')
      const asked = new Set(confirmed)
      if (running.length !== asked.size || running.some((session) => !asked.has(session.id))) {
        throw new TerminalError('The live sessions changed since you confirmed; no sessions were ended. Review the list and confirm again.', 409)
      }
      this.updatingService = true
      return running
    })
    try {
      return await this.endAndSetUp(live, principal, install)
    } finally {
      this.updatingService = false
    }
  }
  private updatingService = false
  private async endAndSetUp(live: Session[], principal: Principal, install: () => Promise<void>): Promise<{ ended: string[] }> {
    const ended: string[] = []
    const so = () => ended.length ? `Ended ${ended.join(', ')}; ` : ''
    for (const session of live) {
      try {
        await this.finish(session.id, principal, session.generation, true)
        ended.push(session.title)
      } catch (error) {
        throw new TerminalError(`${so()}${session.title} could not be ended (${error instanceof Error ? error.message : String(error)}). The update was not applied.`, 409)
      }
    }
    try {
      await this.setupService(install)
    } catch (error) {
      if (!ended.length) throw error
      throw new TerminalError(`${so()}the update was not applied: ${error instanceof Error ? error.message : String(error)}`, error instanceof TerminalError ? error.status : 503)
    }
    return { ended }
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
    // Lifecycle work outside the queue settles before replicas and the store go, until none is left (one
    // can start another): a coalesced refresh (and the one more it owes), every finish (save, then kill),
    // the queue, every final save.
    // The queue first, each time: work it holds (a refresh's liveness check) can start more of it.
    this.stopping = true
    const drain = async () => {
      for (;;) {
        // Until the queue's tail stops moving: work accepted before the cutoff may still queue its next step.
        for (let tail = this.pending; ; tail = this.pending) { await tail; if (tail === this.pending) break }
        const outstanding = [this.refreshing, ...this.refreshes, ...this.sweeps, ...[...this.finishing.values()].flatMap((all) => [...all]), ...this.ending.values()].filter((work) => work !== undefined)
        if (!outstanding.length) return
        await Promise.allSettled(outstanding)
      }
    }
    await drain()
    // One last refresh for deaths heard meanwhile (bounded: hints from here on are not taken).
    if (this.owedAtStop) { await this.trackRefresh().catch(() => undefined); await drain() }
    this.closed = true
    this.attached.clear()
    await this.driver.detach()
    this.store.close()
  }
}
