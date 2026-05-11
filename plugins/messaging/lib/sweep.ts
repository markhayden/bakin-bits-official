import type { PluginContext } from '@bakin/sdk/types'
import type { ContentTypeOption, Deliverable, MessagingSettings, Plan } from '../types'
import { DEFAULT_CONTENT_TYPES } from '../types'
import type { MessagingContentStorage } from './content-storage'
import { recomputePlanStatus } from './plan-status'

export interface MessagingSweepResult {
  ok: true
  processed: number
  startedPrep: number
}

function contentTypeFor(settings: MessagingSettings, contentTypeId: string): ContentTypeOption {
  return (settings.contentTypes ?? DEFAULT_CONTENT_TYPES).find(type => type.id === contentTypeId)
    ?? { id: contentTypeId, label: contentTypeId, assetRequirement: 'none', prepLeadHours: 0 }
}

function prepInstruction(contentType: ContentTypeOption): string {
  const requirement = contentType.assetRequirement ?? 'none'
  const base = 'Write your draft. Then call bakin_exec_messaging_deliverable_update with { draft: { caption } }, then call bakin_exec_messaging_deliverable_ready_for_review.'
  if (requirement === 'image' || requirement === 'optional-image') {
    return `${base} If an image is needed, call bakin_exec_assets_save { filePath, taskId, type: 'images' }, then include the returned filename in your update: { draft: { caption, imageFilename } }.`
  }
  if (requirement === 'video' || requirement === 'optional-video') {
    return `${base} If a video is needed, call bakin_exec_assets_save { filePath, taskId, type: 'video' }, then include the returned filename in your update: { draft: { caption, videoFilename } }.`
  }
  return base
}

function buildPrepTaskDescription(deliverable: Deliverable, plan: Plan | null, contentType: ContentTypeOption): string {
  return [
    `Deliverable: ${deliverable.id}`,
    `Channel: ${deliverable.channel}`,
    `PublishAt: ${deliverable.publishAt}`,
    `Brief: ${deliverable.brief}`,
    '---',
    plan ? `Plan: ${plan.title}` : 'Plan: Quick Post',
    `Content type: ${contentType.label}`,
    prepInstruction(contentType),
  ].join('\n')
}

function prepWindowOpen(deliverable: Deliverable, now: Date): boolean {
  const prepAt = Date.parse(deliverable.prepStartAtOverride ?? deliverable.prepStartAt)
  return !Number.isNaN(prepAt) && prepAt <= now.getTime()
}

async function loadWorkflowInstanceId(ctx: PluginContext, taskId: string, workflowId: string | undefined): Promise<string | undefined> {
  if (!workflowId || !ctx.hooks.has('workflows.loadInstance')) return undefined
  const instance = await ctx.hooks.invoke<{ instanceId?: string }>('workflows.loadInstance', { taskId })
  return instance?.instanceId
}

export async function runMessagingContentSweep(
  store: MessagingContentStorage,
  ctx: PluginContext,
  settings: MessagingSettings,
  now = new Date(),
): Promise<MessagingSweepResult> {
  let processed = 0
  let startedPrep = 0

  for (const deliverable of store.listDeliverables()) {
    if (deliverable.status !== 'planned' || deliverable.taskId || !prepWindowOpen(deliverable, now)) continue
    processed += 1

    const plan = deliverable.planId ? store.getPlan(deliverable.planId) : null
    const contentType = contentTypeFor(settings, deliverable.contentType)
    const task = await ctx.tasks.create({
      title: `Prep: ${plan?.title ?? deliverable.title} - ${deliverable.channel}`,
      agent: deliverable.agent,
      column: 'todo',
      description: buildPrepTaskDescription(deliverable, plan, contentType),
      workflowId: contentType.workflowId || undefined,
    })
    const workflowInstanceId = await loadWorkflowInstanceId(ctx, task.id, contentType.workflowId)

    store.updateDeliverable(deliverable.id, {
      status: 'in_prep',
      taskId: task.id,
      workflowInstanceId,
    })
    if (deliverable.planId) recomputePlanStatus(store, deliverable.planId)
    ctx.activity.audit('deliverable.prep_started', 'system', {
      deliverableId: deliverable.id,
      taskId: task.id,
      workflowId: contentType.workflowId,
      workflowInstanceId,
    })
    ctx.activity.log(deliverable.agent, `Started prep for "${deliverable.title}"`, { taskId: task.id, category: 'messaging' })
    startedPrep += 1
  }

  return { ok: true, processed, startedPrep }
}
