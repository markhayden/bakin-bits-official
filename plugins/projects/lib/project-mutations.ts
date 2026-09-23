import { z } from 'zod'
import { PROJECT_STATUSES } from '../types'

export interface FieldConflict { expected: string; current: string; requested: string }
export class ProjectMutationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly conflicts?: Record<string, FieldConflict>) {
    super(message)
    this.name = 'ProjectMutationError'
  }
}

const projectPatch = z.object({ title: z.string().trim().min(1), owner: z.string(), status: z.enum(PROJECT_STATUSES), body: z.string() }).partial().strict()
const itemPatch = z.object({ title: z.string().trim().min(1), description: z.string() }).partial().strict()

export function validateProjectPatch(input: unknown) {
  const result = projectPatch.safeParse(input)
  if (!result.success) throw new ProjectMutationError('Invalid project fields.', 400, 'invalid_patch')
  return result.data
}
export function validateItemPatch(input: unknown) {
  const result = itemPatch.safeParse(input)
  if (!result.success) throw new ProjectMutationError('Invalid checklist fields.', 400, 'invalid_patch')
  return result.data
}

/** Check the complete write set under the domain lock before mutating anything.
 * Requested values already present are converged, even with an old baseline. */
export function assertExpectedFields(current: object, patch: object, expected: unknown) {
  if (expected === undefined) return
  const fields = Object.entries(patch).filter(([, value]) => value !== undefined)
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || Object.keys(expected).length !== fields.length
    || fields.some(([field]) => !Object.hasOwn(expected, field) || typeof (expected as Record<string, unknown>)[field] !== 'string')) {
    throw new ProjectMutationError('Expected values must name exactly the fields being saved.', 400, 'invalid_precondition')
  }
  const conflicts: Record<string, FieldConflict> = {}
  for (const [field, requested] of fields) {
    const value = (current as Record<string, string>)[field] ?? ''
    const baseline = (expected as Record<string, string>)[field]!
    if (value !== baseline && value !== requested) conflicts[field] = { expected: baseline, current: value, requested: requested as string }
  }
  if (Object.keys(conflicts).length) throw new ProjectMutationError('Some fields changed while you were editing. Review the overlapping changes.', 409, 'field_conflict', conflicts)
}


export function assertItemIdentity(item: { instanceId?: string }, expected: unknown) {
  if (expected === undefined) return
  if (typeof expected !== 'string') throw new ProjectMutationError('Invalid checklist identity.', 400, 'invalid_precondition')
  if ((item.instanceId ?? '') !== expected) throw new ProjectMutationError('This checklist item was replaced. Discard the old draft and refresh.', 409, 'item_replaced')
}
