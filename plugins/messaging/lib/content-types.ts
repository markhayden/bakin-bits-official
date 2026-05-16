import type { PluginContext } from '@makinbakin/sdk/types'
import type { ContentTypeOption } from '../types'
import { DEFAULT_CONTENT_TYPES } from '../types'

const DEFAULTS_BY_ID = new Map(DEFAULT_CONTENT_TYPES.map(type => [type.id, type]))

export interface NormalizeContentTypesOptions {
  workflowExists?: (workflowId: string) => boolean | Promise<boolean>
  onMissingWorkflow?: (contentTypeId: string, workflowId: string) => void
}

export type ContentTypeWorkflowValidationPhase = 'activate' | 'ready'

export interface ContentTypeWorkflowValidationResult {
  status: 'validated' | 'deferred'
  missing: Array<{ contentTypeId: string; workflowId: string }>
}

interface ContentTypeWorkflowLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

function workflowRefs(contentTypes: ContentTypeOption[]): Array<{ contentTypeId: string; workflowId: string }> {
  return contentTypes
    .filter((type): type is ContentTypeOption & { workflowId: string } => Boolean(type.workflowId))
    .map(type => ({ contentTypeId: type.id, workflowId: type.workflowId }))
}

function hasWorkflowValidationHooks(ctx: PluginContext): boolean {
  return ctx.hooks.has('workflows.loadDefinition') &&
    ctx.hooks.has('workflows.approveGate') &&
    ctx.hooks.has('workflows.rejectGate')
}

export async function validateContentTypeWorkflows(
  ctx: PluginContext,
  contentTypes: ContentTypeOption[],
  log: ContentTypeWorkflowLogger,
  phase: ContentTypeWorkflowValidationPhase,
): Promise<ContentTypeWorkflowValidationResult> {
  const refs = workflowRefs(contentTypes)
  if (refs.length === 0) return { status: 'validated', missing: [] }

  if (!hasWorkflowValidationHooks(ctx)) {
    log.info(
      phase === 'activate'
        ? 'Messaging content type workflow validation deferred until ready'
        : 'Messaging content type workflow validation skipped; workflow hooks unavailable',
      {
        phase,
        workflowIds: [...new Set(refs.map(ref => ref.workflowId))],
      },
    )
    return { status: 'deferred', missing: [] }
  }

  const missing: Array<{ contentTypeId: string; workflowId: string }> = []
  for (const ref of refs) {
    try {
      const definition = await ctx.hooks.invoke('workflows.loadDefinition', { workflowId: ref.workflowId })
      if (!definition) missing.push(ref)
    } catch (err) {
      log.info('Messaging content type workflow validation failed; retaining workflowId for task adapter', {
        phase,
        contentTypeId: ref.contentTypeId,
        workflowId: ref.workflowId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (missing.length > 0) {
    if (phase === 'ready') {
      for (const ref of missing) {
        log.warn('Messaging content type references missing workflow definition; retaining workflowId for task adapter', {
          phase,
          ...ref,
        })
      }
    } else {
      log.info('Messaging content type workflow validation found unavailable definitions during activate; will recheck on ready', {
        phase,
        missing,
      })
    }
  }

  return { status: 'validated', missing }
}

export async function normalizeContentTypes(
  existing: ContentTypeOption[] | undefined,
  opts: NormalizeContentTypesOptions = {},
): Promise<{ contentTypes: ContentTypeOption[]; changed: boolean }> {
  const source = existing && existing.length > 0 ? existing : DEFAULT_CONTENT_TYPES
  const normalized: ContentTypeOption[] = []

  for (const type of source) {
    const defaults = DEFAULTS_BY_ID.get(type.id)
    const merged: ContentTypeOption = defaults
      ? { ...defaults, ...withoutUndefined(type as unknown as Record<string, unknown>) }
      : { ...type }

    if (merged.workflowId && opts.workflowExists) {
      const exists = await opts.workflowExists(merged.workflowId)
      if (!exists) {
        opts.onMissingWorkflow?.(merged.id, merged.workflowId)
      }
    }

    normalized.push(merged)
  }

  return {
    contentTypes: normalized,
    changed: JSON.stringify(existing ?? []) !== JSON.stringify(normalized),
  }
}

export async function normalizeContentTypesForActivate(
  ctx: PluginContext,
  existing: ContentTypeOption[] | undefined,
  log: ContentTypeWorkflowLogger,
): Promise<{ contentTypes: ContentTypeOption[]; changed: boolean; workflowValidation: ContentTypeWorkflowValidationResult }> {
  const normalized = await normalizeContentTypes(existing)
  return {
    ...normalized,
    workflowValidation: await validateContentTypeWorkflows(ctx, normalized.contentTypes, log, 'activate'),
  }
}
