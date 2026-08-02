import { usePluginJsonFetch } from '@makinbakin/sdk/hooks'

export const TEMPLATE_PLUGIN_ID = '_template'

export interface TemplateStatus {
  ok: boolean
  plugin: string
}

/** Shared status lifecycle for every template-owned browser surface. */
export function useTemplateStatus() {
  return usePluginJsonFetch<TemplateStatus>(TEMPLATE_PLUGIN_ID, '/')
}
