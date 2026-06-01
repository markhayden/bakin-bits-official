import { basename, extname } from 'path'
import type { PluginContext } from '@makinbakin/sdk/types'
import type { ContentTypeOption, Deliverable, DeliverableFailureStage } from '../types'
import type { MessagingContentStorage } from './content-storage'

/** A resolved attachment for channel delivery (the versioned serve shape). */
type DeliveryFile = { name: string; path: string; contentType?: string }

export type BuildFilesResult =
  | { ok: true; files: DeliveryFile[] }
  | { ok: false; reason: string }

export type PublishDeliverableResult =
  | { ok: true; deliverable: Deliverable; deliveryRef: string }
  | { ok: false; deliverable: Deliverable; reason: string }

type AssetKind = 'image' | 'video'

function draftAssetId(deliverable: Deliverable, kind: AssetKind): string | undefined {
  return kind === 'image'
    ? deliverable.draft.imageAssetId ?? undefined
    : deliverable.draft.videoAssetId ?? undefined
}

function isRequiredAsset(contentType: ContentTypeOption, kind: AssetKind): boolean {
  return (contentType.assetRequirement ?? 'none') === kind
}

export async function buildFilesFromDraft(
  deliverable: Deliverable,
  contentType: ContentTypeOption,
  ctx: PluginContext,
): Promise<BuildFilesResult> {
  const files: DeliveryFile[] = []

  for (const kind of ['image', 'video'] as const) {
    const assetId = draftAssetId(deliverable, kind)
    if (assetId) {
      // Resolve the asset's current version to a file on disk for delivery.
      const ref = await ctx.assets.resolveVersionFile(assetId)
      if (!ref) {
        return { ok: false, reason: `Asset ${assetId} (${kind}) not resolvable` }
      }
      files.push({ name: `${assetId}${extname(ref.absPath) || extname(basename(ref.absPath))}`, path: ref.absPath, contentType: ref.mimeType })
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
  failureStage: DeliverableFailureStage,
  ctx: PluginContext,
): Promise<PublishDeliverableResult> {
  const failed = store.updateDeliverable(deliverable.id, {
    status: 'failed',
    failureReason: reason,
    failureStage,
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
  if (!filesResult.ok) return markPublishFailed(store, deliverable, filesResult.reason, 'validation', ctx)

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
      return markPublishFailed(store, deliverable, 'Channel delivery did not return a delivery reference', 'delivery', ctx)
    }

    const published = store.updateDeliverable(deliverable.id, {
      status: 'published',
      publishedAt: new Date().toISOString(),
      publishedDeliveryRef: delivery.ref,
      failureReason: null as never,
      failureStage: null as never,
      failedStep: null as never,
      failedAt: null as never,
    })
    ctx.activity.audit('deliverable.published', 'system', { deliverableId: deliverable.id, deliveryRef: delivery.ref })
    ctx.activity.log(deliverable.agent, `Published "${deliverable.title}"`)
    return { ok: true, deliverable: published, deliveryRef: delivery.ref }
  } catch (err) {
    return markPublishFailed(
      store,
      deliverable,
      `Channel delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      'delivery',
      ctx,
    )
  }
}
