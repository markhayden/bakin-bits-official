import type { StorageAdapter } from '@makinbakin/sdk/types'
import { generateId } from './ids'
import { atomicWriteJson } from './atomic-write'
import type {
  BrainstormSession,
  Deliverable,
  DeliverableDraft,
  DeliverableStatus,
  Plan,
  PlanStatus,
} from '../types'
import {
  BrainstormSessionSchema,
  DeliverableSchema,
  PlanSchema,
} from '../types'

const SESSIONS_DIR = 'messaging/sessions'
const PLANS_DIR = 'messaging/plans'
const DELIVERABLES_DIR = 'messaging/deliverables'

function entityPath(dir: string, id: string): string {
  return `${dir}/${id}.json`
}

function nowIso(): string {
  return new Date().toISOString()
}

function readJson(storage: StorageAdapter, path: string): unknown | null {
  try {
    if (storage.readJson) return storage.readJson(path)
    const raw = storage.read(path)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function listJsonFiles(storage: StorageAdapter, dir: string): string[] {
  return storage.list?.(dir).filter(file => file.endsWith('.json')) ?? []
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

const CLEARABLE_DELIVERABLE_FIELDS = new Set<keyof Deliverable>([
  'planChannelId',
  'prepStartAtOverride',
  'taskId',
  'workflowInstanceId',
  'pendingGateStepId',
  'rejectionNote',
  'failureReason',
  'failureStage',
  'failedStep',
  'failedAt',
  'publishedAt',
  'publishedDeliveryRef',
])

export type CreateBrainstormSessionInput = Omit<BrainstormSession, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'proposals' | 'createdAtPlanIds' | 'status'> & {
  id?: string
  status?: BrainstormSession['status']
  messages?: BrainstormSession['messages']
  proposals?: BrainstormSession['proposals']
  createdAtPlanIds?: string[]
}

export type CreatePlanInput = Omit<Plan, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
  id?: string
  status?: PlanStatus
}

export type CreateDeliverableInput = Omit<Deliverable, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'draft'> & {
  id?: string
  status?: DeliverableStatus
  draft?: DeliverableDraft
}

export interface MessagingContentStorage {
  createBrainstormSession(input: CreateBrainstormSessionInput): BrainstormSession
  getBrainstormSession(id: string): BrainstormSession | null
  listBrainstormSessions(): BrainstormSession[]
  updateBrainstormSession(id: string, patch: Partial<BrainstormSession>): BrainstormSession
  deleteBrainstormSession(id: string): void
  createPlan(input: CreatePlanInput): Plan
  getPlan(id: string): Plan | null
  listPlans(): Plan[]
  updatePlan(id: string, patch: Partial<Plan>): Plan
  deletePlan(id: string): void
  createDeliverable(input: CreateDeliverableInput): Deliverable
  getDeliverable(id: string): Deliverable | null
  listDeliverables(filter?: { planId?: string | null; status?: DeliverableStatus }): Deliverable[]
  updateDeliverable(id: string, patch: Partial<Deliverable>): Deliverable
  deleteDeliverable(id: string): void
}

export function createMessagingContentStorage(storage: StorageAdapter): MessagingContentStorage {
  function saveBrainstormSession(session: BrainstormSession): void {
    atomicWriteJson(storage, entityPath(SESSIONS_DIR, session.id), BrainstormSessionSchema.parse(session))
  }

  function getBrainstormSession(id: string): BrainstormSession | null {
    const raw = readJson(storage, entityPath(SESSIONS_DIR, id))
    const parsed = BrainstormSessionSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  function listBrainstormSessions(): BrainstormSession[] {
    return listJsonFiles(storage, SESSIONS_DIR)
      .map(file => getBrainstormSession(file.replace(/\.json$/, '')))
      .filter((session): session is BrainstormSession => !!session)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  function createBrainstormSession(input: CreateBrainstormSessionInput): BrainstormSession {
    const timestamp = nowIso()
    const session: BrainstormSession = {
      ...input,
      id: input.id ?? generateId(),
      status: input.status ?? 'active',
      messages: input.messages ?? [],
      proposals: input.proposals ?? [],
      createdAtPlanIds: input.createdAtPlanIds ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    saveBrainstormSession(session)
    return session
  }

  function updateBrainstormSession(id: string, patch: Partial<BrainstormSession>): BrainstormSession {
    const existing = getBrainstormSession(id)
    if (!existing) throw new Error(`Brainstorm session ${id} not found`)
    const cleanPatch = withoutUndefined(patch as Record<string, unknown>) as Partial<BrainstormSession>
    const next: BrainstormSession = {
      ...existing,
      ...cleanPatch,
      id: existing.id,
      updatedAt: nowIso(),
    }
    saveBrainstormSession(next)
    return next
  }

  function deleteBrainstormSession(id: string): void {
    storage.remove?.(entityPath(SESSIONS_DIR, id))
  }

  function savePlan(plan: Plan): void {
    atomicWriteJson(storage, entityPath(PLANS_DIR, plan.id), PlanSchema.parse(plan))
  }

  function getPlan(id: string): Plan | null {
    const raw = readJson(storage, entityPath(PLANS_DIR, id))
    const parsed = PlanSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  function listPlans(): Plan[] {
    return listJsonFiles(storage, PLANS_DIR)
      .map(file => getPlan(file.replace(/\.json$/, '')))
      .filter((plan): plan is Plan => !!plan)
      .sort((a, b) => Date.parse(b.targetDate) - Date.parse(a.targetDate))
  }

  function createPlan(input: CreatePlanInput): Plan {
    const timestamp = nowIso()
    const plan: Plan = {
      ...input,
      id: input.id ?? generateId(),
      status: input.status ?? 'planning',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    savePlan(plan)
    return plan
  }

  function updatePlan(id: string, patch: Partial<Plan>): Plan {
    const existing = getPlan(id)
    if (!existing) throw new Error(`Plan ${id} not found`)
    const cleanPatch = withoutUndefined(patch as Record<string, unknown>) as Partial<Plan>
    const next: Plan = {
      ...existing,
      ...cleanPatch,
      id: existing.id,
      updatedAt: nowIso(),
    }
    savePlan(next)
    return next
  }

  function deletePlan(id: string): void {
    storage.remove?.(entityPath(PLANS_DIR, id))
  }

  function saveDeliverable(deliverable: Deliverable): void {
    atomicWriteJson(storage, entityPath(DELIVERABLES_DIR, deliverable.id), DeliverableSchema.parse(deliverable))
  }

  function getDeliverable(id: string): Deliverable | null {
    const raw = readJson(storage, entityPath(DELIVERABLES_DIR, id))
    const parsed = DeliverableSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  function listDeliverables(filter: { planId?: string | null; status?: DeliverableStatus } = {}): Deliverable[] {
    return listJsonFiles(storage, DELIVERABLES_DIR)
      .map(file => getDeliverable(file.replace(/\.json$/, '')))
      .filter((deliverable): deliverable is Deliverable => !!deliverable)
      .filter(deliverable => filter.planId === undefined || deliverable.planId === filter.planId)
      .filter(deliverable => filter.status === undefined || deliverable.status === filter.status)
      .sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt))
  }

  function createDeliverable(input: CreateDeliverableInput): Deliverable {
    const timestamp = nowIso()
    const deliverable: Deliverable = {
      ...input,
      id: input.id ?? generateId(),
      status: input.status ?? 'proposed',
      draft: input.draft ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    saveDeliverable(deliverable)
    return deliverable
  }

  function updateDeliverable(id: string, patch: Partial<Deliverable>): Deliverable {
    const existing = getDeliverable(id)
    if (!existing) throw new Error(`Deliverable ${id} not found`)
    const cleanPatch = withoutUndefined(patch as Record<string, unknown>) as Partial<Deliverable>
    const next = {
      ...existing,
      ...cleanPatch,
      id: existing.id,
      draft: patch.draft ? { ...existing.draft, ...patch.draft } : existing.draft,
      updatedAt: nowIso(),
    } as Deliverable
    for (const field of CLEARABLE_DELIVERABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field) && (patch as Record<string, unknown>)[field] === null) {
        delete (next as unknown as Record<string, unknown>)[field]
      }
    }
    saveDeliverable(next)
    return next
  }

  function deleteDeliverable(id: string): void {
    storage.remove?.(entityPath(DELIVERABLES_DIR, id))
  }

  return {
    createBrainstormSession,
    getBrainstormSession,
    listBrainstormSessions,
    updateBrainstormSession,
    deleteBrainstormSession,
    createPlan,
    getPlan,
    listPlans,
    updatePlan,
    deletePlan,
    createDeliverable,
    getDeliverable,
    listDeliverables,
    updateDeliverable,
    deleteDeliverable,
  }
}
