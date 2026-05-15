import type { PluginContext } from '@makinbakin/sdk/types'
import type { ContentTypeOption, Deliverable, MessagingSettings, Plan, PlanChannel } from '../types'
import { DEFAULT_CONTENT_TYPES } from '../types'
import type { MessagingContentStorage } from './content-storage'
import { recomputePlanStatus } from './plan-status'

export type ActivatePlanResult =
  | {
    ok: true
    plan: Plan
    deliverables: Deliverable[]
    taskIds: string[]
    alreadyActivated: boolean
  }
  | { ok: false; error: string; status: number }

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

function buildPrepTaskDescription(deliverable: Deliverable, plan: Plan, contentType: ContentTypeOption): string {
  return [
    `Deliverable: ${deliverable.id}`,
    `Channel: ${deliverable.channel}`,
    `PublishAt: ${deliverable.publishAt}`,
    `Brief: ${deliverable.brief}`,
    '---',
    `Plan: ${plan.title}`,
    `Plan ID: ${plan.id}`,
    `Content type: ${contentType.label}`,
    prepInstruction(contentType),
  ].join('\n')
}

function workflowSkipReason(contentType: ContentTypeOption, channel: PlanChannel): string {
  return `Messaging content type "${contentType.id}" has no workflowId configured for channel "${channel.channel}"; created as a bare kickoff task.`
}

function derivePrepStartAt(settings: MessagingSettings, publishAt: string, contentTypeId: string): string {
  const publishTime = Date.parse(publishAt)
  if (Number.isNaN(publishTime)) throw new Error('publishAt must be a valid date')
  const contentType = resolveActivationContentType(settings, contentTypeId)
  if (!contentType) throw new Error(`Unknown contentType: ${contentTypeId}`)
  const prepLeadHours = contentType.prepLeadHours ?? 0
  return new Date(publishTime - prepLeadHours * 60 * 60 * 1000).toISOString()
}

function resolveActivationContentType(settings: MessagingSettings, contentTypeId: string): ContentTypeOption | null {
  return (settings.contentTypes ?? DEFAULT_CONTENT_TYPES).find(type => type.id === contentTypeId) ?? null
}

function validatePlanChannel(channel: PlanChannel): string | null {
  if (!channel.channel) return 'channel is required'
  if (!channel.contentType) return 'contentType is required'
  if (!channel.publishAt) return 'publishAt is required'
  if (Number.isNaN(Date.parse(channel.publishAt))) return 'publishAt must be a valid date'
  if (channel.prepStartAt && Number.isNaN(Date.parse(channel.prepStartAt))) return 'prepStartAt must be a valid date'
  return null
}

async function loadWorkflowInstanceId(ctx: PluginContext, taskId: string, workflowId: string | undefined): Promise<string | undefined> {
  if (!workflowId || !ctx.hooks.has('workflows.loadInstance')) return undefined
  const instance = await ctx.hooks.invoke<{ instanceId?: string }>('workflows.loadInstance', { taskId })
  return instance?.instanceId
}

type PreparedPlanChannel = {
  channel: PlanChannel
  contentType: ContentTypeOption
  publishAt: string
  prepStartAt: string
  agent: string
  workflowId?: string
}

export async function activatePlan(
  ctx: PluginContext,
  store: MessagingContentStorage,
  planId: string,
  settings: MessagingSettings,
): Promise<ActivatePlanResult> {
  const plan = store.getPlan(planId)
  if (!plan) return { ok: false, error: 'Plan not found', status: 404 }

  const existing = store.listDeliverables({ planId }).filter(deliverable => deliverable.status !== 'cancelled')
  const linkedExisting = existing.filter(deliverable => Boolean(deliverable.taskId))
  if (linkedExisting.length > 0) {
    return {
      ok: true,
      plan,
      deliverables: existing,
      taskIds: linkedExisting.map(deliverable => deliverable.taskId).filter((taskId): taskId is string => Boolean(taskId)),
      alreadyActivated: true,
    }
  }
  const unlinkedExisting = existing.filter(deliverable => !deliverable.taskId)
  if (unlinkedExisting.length > 0) {
    for (const deliverable of unlinkedExisting) {
      store.updateDeliverable(deliverable.id, {
        status: 'cancelled',
        rejectionNote: 'Cancelled because Plan-owned content pieces are created only by activation.',
      })
    }
    ctx.activity.audit('plan.unlinked_deliverables.cancelled', plan.agent, {
      planId,
      deliverableIds: unlinkedExisting.map(deliverable => deliverable.id),
    })
  }

  const channels = plan.channels ?? []
  if (channels.length === 0) {
    return { ok: false, status: 400, error: 'Plan channels must be configured before activation' }
  }

  const preparedChannels: PreparedPlanChannel[] = []
  for (const channel of channels) {
    const invalid = validatePlanChannel(channel)
    if (invalid) return { ok: false, status: 400, error: `Invalid channel "${channel.id}": ${invalid}` }

    const contentType = resolveActivationContentType(settings, channel.contentType)
    if (!contentType) {
      return { ok: false, status: 400, error: `Invalid channel "${channel.id}": unknown contentType "${channel.contentType}"` }
    }
    const publishAt = new Date(Date.parse(channel.publishAt)).toISOString()
    const prepStartAt = channel.prepStartAt
      ? new Date(Date.parse(channel.prepStartAt)).toISOString()
      : derivePrepStartAt(settings, publishAt, channel.contentType)

    preparedChannels.push({
      channel,
      contentType,
      publishAt,
      prepStartAt,
      agent: channel.agent ?? contentType.defaultAgent ?? plan.agent,
      workflowId: channel.workflowId ?? contentType.workflowId,
    })
  }

  const deliverables: Deliverable[] = []
  const taskIds: string[] = []
  const createdDeliverableIds: string[] = []
  const attemptedTaskIds: string[] = []

  try {
    for (const { channel, contentType, publishAt, prepStartAt, agent, workflowId } of preparedChannels) {
      const deliverable = store.createDeliverable({
        planId: plan.id,
        planChannelId: channel.id,
        channel: channel.channel,
        contentType: channel.contentType,
        tone: channel.tone ?? 'conversational',
        agent,
        title: channel.title ?? plan.title,
        brief: channel.brief ?? plan.brief,
        publishAt,
        prepStartAt,
        status: 'planned',
      })
      createdDeliverableIds.push(deliverable.id)

      const taskId = `messaging-${deliverable.id}`
      attemptedTaskIds.push(taskId)

      const task = await ctx.tasks.create({
        id: taskId,
        parentId: null,
        agent,
        column: 'todo',
        title: `Prep: ${plan.title} - ${channel.channel}`,
        description: buildPrepTaskDescription(deliverable, plan, contentType),
        workflowId,
        skipWorkflowReason: workflowId ? undefined : workflowSkipReason(contentType, channel),
        availableAt: prepStartAt,
        dueAt: publishAt,
        source: {
          pluginId: 'messaging',
          entityType: 'deliverable',
          entityId: deliverable.id,
          purpose: 'kickoff',
        },
      })
      const workflowInstanceId = await loadWorkflowInstanceId(ctx, task.id, workflowId)

      const updated = store.updateDeliverable(deliverable.id, {
        taskId: task.id,
        workflowInstanceId,
      })
      deliverables.push(updated)
      taskIds.push(task.id)
    }
  } catch (err) {
    for (const deliverableId of createdDeliverableIds) {
      store.deleteDeliverable(deliverableId)
    }
    await Promise.allSettled(attemptedTaskIds.map(taskId => ctx.tasks.remove(taskId)))
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 500, error: `Plan activation failed: ${message}` }
  }

  const updatedPlan = recomputePlanStatus(store, plan.id)
  ctx.activity.audit('plan.activated', plan.agent, { planId: plan.id, deliverableIds: deliverables.map(item => item.id), taskIds })
  ctx.activity.log(plan.agent, `Activated content Plan "${plan.title}"`)
  return { ok: true, plan: updatedPlan, deliverables, taskIds, alreadyActivated: false }
}
