import type { AssetFileRef, PluginContext } from '@bakin/sdk/types'
import type { ContentTypeOption, Deliverable } from '../types'
import type { MessagingContentStorage } from './content-storage'

export type BuildFilesResult =
  | { ok: true; files: AssetFileRef[] }
  | { ok: false; reason: string }

export type PublishDeliverableResult =
  | { ok: true; deliverable: Deliverable; deliveryRef: string }
  | { ok: false; deliverable: Deliverable; reason: string }

type AssetKind = 'image' | 'video'

function draftFilename(deliverable: Deliverable, kind: AssetKind): string | undefined {
  return kind === 'image'
    ? deliverable.draft.imageFilename ?? undefined
    : deliverable.draft.videoFilename ?? undefined
}

function isRequiredAsset(contentType: ContentTypeOption, kind: AssetKind): boolean {
  return (contentType.assetRequirement ?? 'none') === kind
}

export async function buildFilesFromDraft(
  deliverable: Deliverable,
  contentType: ContentTypeOption,
  ctx: PluginContext,
): Promise<BuildFilesResult> {
  const files: AssetFileRef[] = []

  for (const kind of ['image', 'video'] as const) {
    const filename = draftFilename(deliverable, kind)
    if (filename) {
      try {
        files.push(await ctx.assets.fileRef(filename))
      } catch (err) {
        return {
          ok: false,
          reason: `Asset ${filename} (${kind}) not resolvable: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    } else if (isRequiredAsset(contentType, kind)) {
      return { ok: false, reason: `Required ${kind} asset missing on Deliverable` }
    }
  }

  return { ok: true, files }
}

async function notifyPublishFailure(ctx: PluginContext, deliverable: Deliverable, reason: string): Promise<void> {
  try {
    await ctx.runtime.channels.sendMessage({
      channels: [deliverable.channel],
      message: {
        title: `Publish failed: ${deliverable.title}`,
        body: reason,
        metadata: { deliverableId: deliverable.id, planId: deliverable.planId },
      },
    })
  } catch {
    // Failure notification is best-effort; the Deliverable state is the source of truth.
  }
}

async function markPublishFailed(
  store: MessagingContentStorage,
  deliverable: Deliverable,
  reason: string,
  ctx: PluginContext,
): Promise<PublishDeliverableResult> {
  const failed = store.updateDeliverable(deliverable.id, {
    status: 'failed',
    failureReason: reason,
    failedAt: new Date().toISOString(),
  })
  ctx.activity.audit('deliverable.publish_failed', 'system', { deliverableId: deliverable.id, reason })
  ctx.activity.log(deliverable.agent, `Publish failed for "${deliverable.title}": ${reason}`)
  await notifyPublishFailure(ctx, deliverable, reason)
  return { ok: false, deliverable: failed, reason }
}

export async function publishDeliverableNow(
  store: MessagingContentStorage,
  deliverable: Deliverable,
  contentType: ContentTypeOption,
  ctx: PluginContext,
): Promise<PublishDeliverableResult> {
  const filesResult = await buildFilesFromDraft(deliverable, contentType, ctx)
  if (!filesResult.ok) return markPublishFailed(store, deliverable, filesResult.reason, ctx)

  try {
    const result = await ctx.runtime.channels.deliverContent({
      channels: [deliverable.channel],
      content: {
        title: deliverable.title,
        body: deliverable.draft.caption ?? deliverable.brief,
        files: filesResult.files,
        metadata: {
          deliverableId: deliverable.id,
          planId: deliverable.planId,
          contentType: deliverable.contentType,
        },
      },
    })
    const delivery = result.deliveries[0]
    if (!delivery?.ref) {
      return markPublishFailed(store, deliverable, 'Channel delivery did not return a delivery reference', ctx)
    }

    const published = store.updateDeliverable(deliverable.id, {
      status: 'published',
      publishedAt: new Date().toISOString(),
      publishedDeliveryRef: delivery.ref,
    })
    ctx.activity.audit('deliverable.published', 'system', { deliverableId: deliverable.id, deliveryRef: delivery.ref })
    ctx.activity.log(deliverable.agent, `Published "${deliverable.title}"`)
    return { ok: true, deliverable: published, deliveryRef: delivery.ref }
  } catch (err) {
    return markPublishFailed(
      store,
      deliverable,
      `Channel delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      ctx,
    )
  }
}
