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
  | { skipped: StewardSkipReason | 'disabled' | 'not_found' | 'daily_cap' | 'create_failed' }

export interface StewardLoop {
  /** One scan; joins a scan already running for the project (single-flight). */
  scan(projectId: string, opts?: { force?: boolean }): Promise<StewardScanOutcome>
  scanAll(): Promise<void>
  reconcile(projectId: string): Promise<void>
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
    return true
  }

  /** Close the open run: what the board looks like NOW is what this run handled (D20a). */
  async function finalize(projectId: string, taskId: string, how: 'done' | 'abandoned' | 'foreign'): Promise<void> {
    const project = repo.readProject(projectId)
    if (!project) return
    const tasks = await ctx.tasks.list({ projectId })
    const at = now()
    const digest = buildStewardDigest(project, tasks, { now: at, stuckAfterMs: stuckAfterMs(), steward: project.steward })
    const closed = await writeSteward(projectId, current => {
      const steward = current.steward
      if (steward?.openTaskId !== taskId) return false
      current.steward = {
        ...(steward.runs ? { runs: steward.runs } : {}),
        ...(steward.capNotedOn ? { capNotedOn: steward.capNotedOn } : {}),
        // A foreign task never ran for this project: nothing was handled.
        ...(how === 'foreign'
          ? { ...(steward.lastFingerprint ? { lastFingerprint: steward.lastFingerprint } : {}), ...(steward.lastStewardAt ? { lastStewardAt: steward.lastStewardAt } : {}) }
          : { lastFingerprint: digest.fingerprint, lastStewardAt: at.toISOString() }),
      }
      return true
    })
    if (!closed) return
    if (how !== 'done') ctx.activity.audit(`steward.${how}`, 'system', { projectId, taskId })
    changed(projectId)
  }

  async function reconcile(projectId: string): Promise<void> {
    const steward = repo.readProject(projectId)?.steward
    const taskId = steward?.openTaskId
    if (!taskId) return
    const task: Task | null = await ctx.tasks.get(taskId)
    if (!task) {
      if (steward.phase === 'reserved' && steward.frozen) {
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
      current.steward = {
        ...current.steward,
        openTaskId,
        phase: 'reserved',
        frozen,
        reservedAt: at.toISOString(),
        fingerprint: digest.fingerprint,
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
    // Steward transitions never trigger a scan — that is how a run can't feed itself.
    if (!projectId || !task || isStewardTask(task) || typeof data.to !== 'string' || !TRIGGER_COLUMNS.has(data.to)) return
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
    onTaskStatusChanged,
    start() {
      if (timer) clearInterval(timer)
      timer = setInterval(() => { void scanAll() }, settings().scanMinutes * 60_000)
      // A backstop, not a reason to keep the process alive.
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      for (const pending of debounces.values()) clearTimeout(pending)
      debounces.clear()
    },
  }
}
