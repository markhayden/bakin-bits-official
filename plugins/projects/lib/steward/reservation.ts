/**
 * The steward loop (D20–D22): cheap scans on a timer and on work-task
 * transitions; at most ONE open steward task per project, reserved before it
 * is created so every trigger, retry and crash converges on the same task.
 *
 * Order per scan (single-flight per project): reconcile the reservation →
 * digest → decide (eligibility, fingerprint gate) → daily cap → reserve under
 * the project lock (frozen create inputs, pre-minted id) → create OUTSIDE the
 * lock (task hooks can re-enter Projects) → mark created. Bookkeeping never
 * depends on the agent calling checkin or on a hook arriving: reconcile reads
 * the board.
 */
import type { PluginContext, Task } from '@makinbakin/sdk/types'
import type { ProjectRepository } from '../parser'
import { withProjectLock } from '../project-service'
import type { Project, ProjectStewardState } from '../../types'
import { buildStewardDigest, isStewardTask, STEWARD_ENTITY_TYPE } from './digest'
import { syncGateStates } from './gates'
import { buildStewardDescription } from './prompt'
import { decideStewardRun, stewardEligibility, type StewardSkipReason } from './scan'

const log = {
  info: (...args: unknown[]) => console.info('[projects:steward]', ...args),
  warn: (...args: unknown[]) => console.warn('[projects:steward]', ...args),
  error: (...args: unknown[]) => console.error('[projects:steward]', ...args),
}

export const STEWARD_TAG = 'project-steward'
/** Work-task transitions worth a prompt look (D21). */
const TRIGGER_COLUMNS = new Set(['done', 'blocked', 'review'])
const OPEN_EXCLUDED = new Set(['done', 'archived'])
export const STEWARD_EVENT_DEBOUNCE_MS = 30_000

export interface StewardSettings {
  enabled: boolean
  scanMinutes: number
  stuckAfterHours: number
  maxRunsPerDay: number
}

export const STEWARD_DEFAULTS: StewardSettings = { enabled: true, scanMinutes: 15, stuckAfterHours: 24, maxRunsPerDay: 6 }

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function readStewardSettings(ctx: PluginContext): StewardSettings {
  const raw = ctx.getSettings<Record<string, unknown>>() ?? {}
  return {
    enabled: raw.stewardEnabled !== false,
    scanMinutes: positive(raw.stewardScanMinutes, STEWARD_DEFAULTS.scanMinutes),
    stuckAfterHours: positive(raw.stewardStuckAfterHours, STEWARD_DEFAULTS.stuckAfterHours),
    maxRunsPerDay: Math.floor(positive(raw.stewardMaxRunsPerDay, STEWARD_DEFAULTS.maxRunsPerDay)),
  }
}

/** The local calendar day (server tz) the daily cap counts against. */
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export type StewardScanOutcome =
  | { created: string }
  | { skipped: StewardSkipReason | 'disabled' | 'stopped' | 'not_found' | 'daily_cap' | 'create_failed' }

export interface StewardLoop {
  /** One scan; joins a scan already running for the project (single-flight). */
  scan(projectId: string, opts?: { force?: boolean }): Promise<StewardScanOutcome>
  scanAll(): Promise<void>
  reconcile(projectId: string): Promise<void>
  /** Durably ask for one run regardless of the fingerprint (Start's hand-off). */
  requestRun(projectId: string, kind: 'handoff' | 'decision'): Promise<void>
  /** The tasks.statusChanged handler: debounced scans for work-task transitions. */
  onTaskStatusChanged(payload: unknown): void
  start(): void
  stop(): void
}

export interface StewardLoopDeps {
  ctx: PluginContext
  repo: ProjectRepository
  now?: () => Date
  settings?: () => StewardSettings
  debounceMs?: number
}

type Reservation = Required<Pick<ProjectStewardState, 'openTaskId' | 'frozen'>>

export function createStewardLoop({ ctx, repo, now = () => new Date(), settings = () => readStewardSettings(ctx), debounceMs = STEWARD_EVENT_DEBOUNCE_MS }: StewardLoopDeps): StewardLoop {
  const flights = new Map<string, Promise<StewardScanOutcome>>()
  const followUps = new Map<string, { force: boolean; promise: Promise<StewardScanOutcome> }>()
  const debounces = new Map<string, ReturnType<typeof setTimeout>>()
  let timer: ReturnType<typeof setInterval> | null = null
  // stop() bumps the generation: a scan that started before shutdown never
  // reserves after it, and nothing new starts until start().
  let generation = 0
  let stopped = false

  const changed = (projectId: string) => ctx.events.emit('projects.changed', { projectId, action: 'steward' })
  const stuckAfterMs = () => settings().stuckAfterHours * 3_600_000

  /** Write steward bookkeeping under the lock — never touches `project.updated`. */
  function writeSteward(projectId: string, mutate: (project: Project) => boolean): Promise<boolean> {
    return withProjectLock(() => {
      const project = repo.readProject(projectId)
      if (!project || !mutate(project)) return false
      repo.writeProject(project)
      return true
    })
  }

  function stewardSource(projectId: string) {
    return { pluginId: 'projects', entityType: STEWARD_ENTITY_TYPE, entityId: projectId }
  }

  /** Create the reserved task from its frozen inputs; an existing id means an earlier attempt landed. */
  async function createReserved(projectId: string, reservation: Reservation): Promise<boolean> {
    // After stop() nothing new reaches the board; the durable reservation is
    // recovered by the next loop's reconcile.
    if (stopped) return false
    try {
      await ctx.tasks.create({
        id: reservation.openTaskId,
        title: reservation.frozen.title,
        agent: reservation.frozen.assignee,
        description: reservation.frozen.description,
        projectId,
        tags: [STEWARD_TAG],
        source: stewardSource(projectId),
      })
    } catch (err) {
      // A throw may follow a durable create (or name a duplicate id): the board decides.
      const existing = await ctx.tasks.get(reservation.openTaskId).catch(() => null)
      if (!existing) {
        log.warn('steward task create failed; the reservation stays for the next scan', { projectId, err })
        return false
      }
    }
    await writeSteward(projectId, project => {
      if (project.steward?.openTaskId !== reservation.openTaskId || project.steward.phase !== 'reserved') return false
      project.steward.phase = 'created'
      return true
    })
    // The reservation was cancelled (completed/archived project) or
    // finalized while this create was in flight: nothing tracks the task
    // any more, so it must not linger on the board.
    if (repo.readProject(projectId)?.steward?.openTaskId !== reservation.openTaskId) {
      // Removed, not archived: deleting a task is what aborts a dispatch
      // turn that may already have picked it up.
      await ctx.tasks.remove(reservation.openTaskId)
      ctx.activity.audit('steward.orphan_removed', 'system', { projectId, taskId: reservation.openTaskId })
      return false
    }
    return true
  }

  /**
   * Close the open run: the board as the run left it is what it handled
   * (D20a). Runs as soon as the check-in's own transition arrives (the
   * reconcile at every scan is the backstop), and the fingerprint is taken
   * against the NEW watermark — `work-done`/`stalled` measured from the
   * finalized `lastStewardAt`, exactly as the next scan will measure them —
   * so finalizing never changes the fingerprint by itself.
   */
  async function finalize(projectId: string, taskId: string, how: 'done' | 'abandoned' | 'foreign'): Promise<void> {
    const project = repo.readProject(projectId)
    if (!project) return
    const tasks = await ctx.tasks.list({ projectId })
    const at = now()
    const handledColumns = Object.fromEntries(tasks.filter(task => !isStewardTask(task)).map(task => [task.id, task.column]))
    // Completions the run could have seen are consumed; ones after its brief
    // was frozen stay (they are new work for the next look).
    const briefMs = Date.parse(project.steward?.reservedAt ?? '')
    const keptCompletions = Object.fromEntries(Object.entries(project.steward?.completions ?? {})
      .filter(([, when]) => how === 'done' && Number.isFinite(briefMs) && Date.parse(when) > briefMs))
    const digest = buildStewardDigest(project, tasks, { now: at, stuckAfterMs: stuckAfterMs(), steward: { ...project.steward, lastStewardAt: at.toISOString(), handledColumns, completions: keptCompletions } })
    // Work that finished, blocked or went to review AFTER the brief was
    // frozen was never in front of this run: it earns a follow-up rather
    // than being acknowledged by finalizing (the daily cap bounds it).
    // An actual COLUMN change, not an edit: descriptions, reassignment and
    // logs move `updatedAt` too. Deliverables this run itself sent to review
    // for sign-off are its own doing, not unseen work.
    const brief = project.steward?.briefColumns
    const ownSignoffs = new Set(Object.entries(project.gates ?? {})
      .filter(([key, gate]) => key.startsWith('signoff:') && gate.stewardTaskId === taskId)
      .map(([key]) => key.slice('signoff:'.length)))
    const unseen = how === 'done' && brief !== undefined && tasks.some(task =>
      !isStewardTask(task) && TRIGGER_COLUMNS.has(task.column) && brief[task.id] !== task.column && !ownSignoffs.has(task.id))
    const closed = await writeSteward(projectId, current => {
      const steward = current.steward
      if (steward?.openTaskId !== taskId) return false
      current.steward = {
        ...(steward.runs ? { runs: steward.runs } : {}),
        ...(steward.capNotedOn ? { capNotedOn: steward.capNotedOn } : {}),
        // A decision that landed while this run was open, or work it never
        // saw, still earns its follow-up.
        ...(steward.runNext ? { runNext: steward.runNext } : unseen ? { runNext: 'decision' as const } : {}),
        // A foreign task never ran for this project: nothing was handled.
        ...(how === 'foreign'
          ? { ...(steward.lastFingerprint ? { lastFingerprint: steward.lastFingerprint } : {}), ...(steward.lastStewardAt ? { lastStewardAt: steward.lastStewardAt } : {}), ...(steward.handledColumns ? { handledColumns: steward.handledColumns } : {}) }
          : { lastFingerprint: digest.fingerprint, lastStewardAt: at.toISOString(), handledColumns, ...(Object.keys(keptCompletions).length ? { completions: keptCompletions } : {}) }),
      }
      return true
    })
    if (!closed) return
    if (how !== 'done') ctx.activity.audit(`steward.${how}`, 'system', { projectId, taskId })
    changed(projectId)
  }

  async function reconcile(projectId: string): Promise<void> {
    if (stopped) return
    await syncGateStates(ctx, repo, projectId)
    const project = repo.readProject(projectId)
    const steward = project?.steward
    const taskId = steward?.openTaskId
    if (!project || !taskId) return
    const task: Task | null = await ctx.tasks.get(taskId)
    if (stopped) return
    // A project that stopped being Active (a completion or archive whose
    // cleanup never finished, e.g. a crash) keeps no check-in: the open one
    // is removed (aborting a running turn) and nothing is recovered.
    const retired = project.status !== 'active'
    if (!task) {
      if (steward.phase === 'reserved' && steward.frozen && !retired) {
        // Paused: keep the reservation (a hand-off's included) — Resume
        // recovers the very same task. Nothing is created while paused.
        if (project.stewardPaused) return
        await createReserved(projectId, { openTaskId: taskId, frozen: steward.frozen })
        return
      }
      await finalize(projectId, taskId, 'abandoned')
      return
    }
    if (!isStewardTask(task, projectId)) {
      await finalize(projectId, taskId, 'foreign')
      return
    }
    if (retired && !OPEN_EXCLUDED.has(task.column)) {
      await ctx.tasks.remove(taskId)
      await finalize(projectId, taskId, 'abandoned')
      return
    }
    if (steward.phase === 'reserved') {
      await writeSteward(projectId, project => {
        if (project.steward?.openTaskId !== taskId || project.steward.phase !== 'reserved') return false
        project.steward.phase = 'created'
        return true
      })
    }
    if (OPEN_EXCLUDED.has(task.column)) await finalize(projectId, taskId, 'done')
  }

  async function runScan(projectId: string, force: boolean): Promise<StewardScanOutcome> {
    const started = generation
    const config = settings()
    if (!config.enabled) return { skipped: 'disabled' }
    await reconcile(projectId)
    const project = repo.readProject(projectId)
    if (!project) return { skipped: 'not_found' }
    // Cheap exit before the board read.
    const ineligible = stewardEligibility(project)
    if (ineligible) return { skipped: ineligible }
    const tasks = await ctx.tasks.list({ projectId })
    const at = now()
    const digest = buildStewardDigest(project, tasks, { now: at, stuckAfterMs: stuckAfterMs(), steward: project.steward })
    const decision = decideStewardRun(project, digest, { now: at, stuckAfterMs: stuckAfterMs(), force })
    if (!decision.run) return { skipped: decision.reason }

    const reserved = await withProjectLock((): Reservation | StewardScanOutcome => {
      if (generation !== started || stopped) return { skipped: 'stopped' }
      const current = repo.readProject(projectId)
      if (!current) return { skipped: 'not_found' }
      const again = stewardEligibility(current)
      if (again) return { skipped: again }
      const today = localDay(at)
      const runs = current.steward?.runs?.date === today ? current.steward.runs.count : 0
      if (runs >= config.maxRunsPerDay) {
        if (current.steward?.capNotedOn !== today) {
          current.steward = { ...current.steward, capNotedOn: today }
          repo.writeProject(current)
          ctx.activity.audit('steward.cap_reached', 'system', { projectId, maxRunsPerDay: config.maxRunsPerDay })
          changed(projectId)
        }
        return { skipped: 'daily_cap' }
      }
      const openTaskId = `task-${crypto.randomUUID()}`
      const frozen = {
        title: `Check in: ${current.title}`,
        assignee: current.owner,
        description: buildStewardDescription({
          project: current,
          digest,
          taskId: openTaskId,
          recentRows: repo.readBrainstormMessages(projectId),
          kickoff: decision.reason === 'forced',
        }),
      }
      const { runNext: _consumed, ...prior } = current.steward ?? {}
      current.steward = {
        ...prior,
        openTaskId,
        phase: 'reserved',
        frozen,
        reservedAt: at.toISOString(),
        fingerprint: digest.fingerprint,
        briefColumns: Object.fromEntries(digest.workTasks.map(task => [task.id, task.column])),
        runs: { date: today, count: runs + 1 },
      }
      repo.writeProject(current)
      ctx.activity.audit('steward.reserved', 'system', { projectId, taskId: openTaskId, reason: decision.reason, signals: digest.signals.map(s => s.kind) })
      return { openTaskId, frozen }
    })
    if ('skipped' in reserved || 'created' in reserved) return reserved
    changed(projectId)
    return (await createReserved(projectId, reserved)) ? { created: reserved.openTaskId } : { skipped: 'create_failed' }
  }

  function scan(projectId: string, opts: { force?: boolean } = {}): Promise<StewardScanOutcome> {
    if (stopped) return Promise.resolve({ skipped: 'stopped' })
    const force = Boolean(opts.force)
    const running = flights.get(projectId)
    if (running) {
      // Everything that arrives mid-scan shares ONE follow-up (a forced
      // caller upgrades it); it runs after, and sees what this one reserved.
      const queued = followUps.get(projectId)
      if (queued) {
        queued.force ||= force
        return queued.promise
      }
      const followUp = { force, promise: Promise.resolve<StewardScanOutcome>({ skipped: 'not_found' }) }
      followUp.promise = running.catch(() => undefined).then(() => {
        followUps.delete(projectId)
        return scan(projectId, { force: followUp.force })
      })
      followUps.set(projectId, followUp)
      return followUp.promise
    }
    const flight = runScan(projectId, force).finally(() => flights.delete(projectId))
    flights.set(projectId, flight)
    return flight
  }

  async function scanAll(): Promise<void> {
    for (const project of repo.readAllProjects()) {
      if (project.status !== 'active' && !project.steward?.openTaskId) continue
      try {
        await scan(project.id)
      } catch (err) {
        log.error('steward scan failed', err, { projectId: project.id })
      }
    }
  }

  function onTaskStatusChanged(payload: unknown): void {
    const data = payload as { to?: unknown; task?: Task } | null
    const task = data?.task
    const projectId = task?.projectId
    if (stopped || !projectId || !task || typeof data.to !== 'string') return
    // A finished check-in is finalized at once (what it handled is the board
    // NOW), but never triggers a scan — that is how a run can't feed itself.
    if (isStewardTask(task)) {
      if (OPEN_EXCLUDED.has(data.to)) reconcile(projectId).catch(err => log.error('steward finalize failed', err, { projectId }))
      return
    }
    if (!TRIGGER_COLUMNS.has(data.to)) return
    // A transition INTO done is recorded durably: re-finishing reopened work
    // must count even though its column matches what the last run left.
    if (data.to === 'done' && (data as { from?: unknown }).from !== 'done') {
      const taskId = task.id
      writeSteward(projectId, project => {
        project.steward = { ...project.steward, completions: { ...project.steward?.completions, [taskId]: now().toISOString() } }
        return true
      }).catch(err => log.error('steward completion record failed', err, { projectId }))
    }
    if (debounces.has(projectId)) return
    const pending = setTimeout(() => {
      debounces.delete(projectId)
      scan(projectId).catch(err => log.error('steward event scan failed', err, { projectId }))
    }, debounceMs)
    pending.unref?.()
    debounces.set(projectId, pending)
  }

  return {
    scan,
    scanAll,
    reconcile,
    async requestRun(projectId, kind) {
      await writeSteward(projectId, project => {
        project.steward = { ...project.steward, runNext: kind }
        return true
      })
    },
    onTaskStatusChanged,
    start() {
      stopped = false
      if (timer) clearInterval(timer)
      timer = setInterval(() => { void scanAll() }, settings().scanMinutes * 60_000)
      // A backstop, not a reason to keep the process alive.
      timer.unref?.()
    },
    stop() {
      stopped = true
      generation += 1
      followUps.clear()
      if (timer) clearInterval(timer)
      timer = null
      for (const pending of debounces.values()) clearTimeout(pending)
      debounces.clear()
    },
  }
}
