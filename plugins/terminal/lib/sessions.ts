import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { authorize, createSchema, DAY, TerminalError, type CreateInput, type Principal, type Session, type TerminalSettings } from './contracts'
import type { ProcessDriver } from './processes'
import { Screen } from './screen'
import { Store } from './store'

interface WorktreeResult { ok: boolean; error?: string; worktreePath?: string }
export interface SessionOptions {
  settings(): TerminalSettings
  prepare(input: { repoPath: string; sessionId: string; agent: string }): Promise<WorktreeResult | undefined>
  release(input: { sessionId: string; worktreePath: string }): Promise<WorktreeResult | undefined>
  validateLinks?(input: CreateInput): Promise<void>
  now?(): number
}

export class Sessions {
  private pending: Promise<unknown> = Promise.resolve()
  private screens = new Map<string, Screen>()
  private closed = false
  constructor(readonly store: Store, private driver: ProcessDriver, private options: SessionOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now() }
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
  async start(): Promise<void> {
    for (const session of this.store.sessions()) {
      if (session.state !== 'running') continue
      if (await this.driver.alive(session.id)) this.attach(session)
      else { session.state = 'exited'; this.store.save(session) }
    }
  }
  refreshStates(): Promise<void> {
    return this.run(async () => {
      for (const session of this.store.sessions()) {
        if (session.state === 'running' && !await this.driver.alive(session.id)) {
          session.state = 'exited'
          this.store.save(session)
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
        void screen.write(chunk, () => this.store.append(session.id, chunk)).catch(() => undefined)
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
      }
      return this.screens.get(id)!
    })
  }
  create(raw: unknown, principal: Principal): Promise<Session> {
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
        generation: 1, inputSequence: 0, cols: 100, rows: 30, state: 'running',
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
      this.store.save(session)
      await this.driver.create(session)
      session.state = 'running'
      this.store.save(session)
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
      this.store.save(session)
      return session
    })
  }
  write(id: string, principal: Principal, generation: number, sequence: number, data: string): Promise<Session> {
    return this.run(async () => {
      const session = this.get(id, principal)
      authorize(session, principal, this.enabled(), true, generation)
      if (session.state !== 'running') throw new TerminalError('Session has exited')
      if (sequence !== session.inputSequence + 1) throw new TerminalError('Input sequence is stale or out of order; do not retry ambiguous input')
      if (Buffer.byteLength(data) > 65536) throw new TerminalError('Input exceeds 64 KiB', 413)
      // Consume the sequence before delivery. A transport failure is never auto-retried.
      session.inputSequence = sequence
      session.lastActivityAt = this.now()
      this.store.save(session)
      this.driver.write(id, data)
      return session
    })
  }
  resize(id: string, principal: Principal, generation: number, cols: number, rows: number): Promise<Session> {
    return this.run(async () => {
      const session = this.get(id, principal)
      authorize(session, principal, this.enabled(), true, generation)
      if (session.state !== 'running') throw new TerminalError('Session has exited')
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 150) throw new TerminalError('Invalid terminal dimensions', 400)
      await this.driver.resize(id, cols, rows)
      this.screens.get(id)?.resize(cols, rows)
      session.cols = cols; session.rows = rows
      this.store.save(session)
      return session
    })
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
      this.store.save(session)
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
  async readScreen(id: string, principal: Principal): Promise<string> {
    const screen = await this.ensureScreen(id, principal)
    const text = await screen.capture(() => screen.text())
    this.get(id, principal)
    return text
  }
  output(id: string, principal: Principal, cursor: number) {
    const session = this.get(id, principal)
    if (session.state === 'running' && (!this.driver.connected(id) || this.screens.get(id)?.failed)) throw new TerminalError('Terminal attachment is unavailable; reconnect required', 503)
    const output = this.store.output(id, cursor)
    return { session, ...output, data: output.data.toString('base64') }
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
    this.store.save(session)
  }
  deleteSession(id: string, principal: Principal): Promise<void> {
    return this.run(async () => {
      if (principal.kind !== 'human') throw new TerminalError('Only the human can delete a session', 403)
      const session = this.get(id, principal)
      // The operator can always close an ended session; only a live process or
      // a retained worktree (which would orphan its branch) is a real wall.
      if (session.state === 'running') throw new TerminalError('End the session before deleting it')
      if (session.worktreePath) throw new TerminalError('Review the retained worktree before deleting this session')
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
    this.store.save(session)
  }
  private async sweepUnlocked(): Promise<void> {
    for (const session of this.store.sessions()) {
      if (this.now() - session.lastActivityAt >= (this.options.settings().idleDays ?? 30) * DAY) {
        if (session.state === 'exited') {
          await this.driver.terminate(session.id)
          await this.stopScreen(session.id)
          session.state = 'completed'
          session.completedAt = this.now()
          this.store.save(session)
        }
      }
      if (session.state === 'completed') await this.clean(session)
      if (session.completedAt !== undefined && this.now() - session.completedAt >= 30 * DAY && !session.historyDeleted) await this.deleteHistoryUnlocked(session.id, { kind: 'human', id: 'maintenance' })
    }
  }
  sweep(): Promise<void> { return this.run(() => this.sweepUnlocked()) }
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
