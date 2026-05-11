import type { PluginContext } from '@bakin/sdk/types'
import type { ContentTypeOption } from '../types'
import { DEFAULT_CONTENT_TYPES } from '../types'

const DEFAULTS_BY_ID = new Map(DEFAULT_CONTENT_TYPES.map(type => [type.id, type]))

export interface NormalizeContentTypesOptions {
  workflowExists?: (workflowId: string) => boolean | Promise<boolean>
  onMissingWorkflow?: (contentTypeId: string, workflowId: string) => void
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
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
        delete merged.workflowId
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
  warn: (message: string, data?: Record<string, unknown>) => void,
): Promise<{ contentTypes: ContentTypeOption[]; changed: boolean }> {
  return normalizeContentTypes(existing, {
    workflowExists: async (workflowId) => {
      if (!ctx.hooks.has('workflows.loadDefinition')) return false
      try {
        const definition = await ctx.hooks.invoke('workflows.loadDefinition', { workflowId })
        return !!definition
      } catch {
        return false
      }
    },
    onMissingWorkflow: (contentTypeId, workflowId) => {
      warn('Messaging content type workflow unavailable; falling back to bare-task lifecycle', {
        contentTypeId,
        workflowId,
      })
    },
  })
}
