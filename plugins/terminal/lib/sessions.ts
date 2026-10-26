import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { authorize, createSchema, DAY, DeliveryUncertainError, TerminalError, type CreateInput, type Principal, type Session, type SizeClaimant, type TerminalSettings } from './contracts'
import type { ProcessDriver } from './processes'
import { claimSize, clampSize, nextSize } from './sizing'
import { Screen } from './screen'
import { Store } from './store'

interface WorktreeResult { ok: boolean; error?: string; worktreePath?: string }
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
          this.save(session)
        }
      }
    })
  }
  private attach(session: Session): void {
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
    })
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
      if (session.state !== 'running') throw new TerminalError('Live terminal screen unavailable', 503)
      if (!this.driver.connected(id) || this.screens.get(id)?.failed || !this.screens.has(id)) {
        await this.stopScreen(id)
        if (!await this.driver.alive(id)) throw new TerminalError('Terminal process has exited', 409)
        this.attach(session)
        // A fresh attachment starts from tmux's real window, whatever the record says.
        try { this.adoptSize(session, await this.driver.windowSize(id)) }
        catch {
          await this.stopScreen(id)
          throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
        }
      }
      return this.screens.get(id)!
    })
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
      if (input.program !== 'shell' && input.checkout === 'isolated') {
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
      this.attach(session)
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
        session.owner = { kind: 'agent', id: session.agentId }
      } else session.owner = principal
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
          this.attach(session)
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
    await this.pending
    this.closed = true
    await this.driver.detach()
    for (const screen of this.screens.values()) { await screen.drain(); screen.close() }
    this.screens.clear()
    this.store.close()
  }
}
