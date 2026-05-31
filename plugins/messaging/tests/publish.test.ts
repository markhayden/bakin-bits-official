import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PluginContext } from '@makinbakin/sdk/types'

type VersionFileRef = { absPath: string; mimeType: string; version: number }
import type { ContentTypeOption, Deliverable } from '../types'
import { MarkdownStorageAdapter } from '../test-helpers'
import { createMessagingContentStorage } from '../lib/content-storage'
import { buildFilesFromDraft, publishDeliverableNow } from '../lib/publish'

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'deliverable-1',
    planId: null,
    channel: 'general',
    contentType: 'blog',
    tone: 'conversational',
    agent: 'basil',
    title: 'Taco post',
    brief: 'Write about tacos.',
    publishAt: '2026-05-25T16:00:00Z',
    prepStartAt: '2026-05-25T12:00:00Z',
    status: 'approved',
    draft: {},
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

function contentType(overrides: Partial<ContentTypeOption> = {}): ContentTypeOption {
  return { id: 'blog', label: 'Blog post', assetRequirement: 'none', ...overrides }
}

function createCtx(opts: {
  resolveVersionFile?: (assetId: string) => Promise<VersionFileRef | null>
  deliverContent?: (input: { channels: string[] }) => Promise<{ deliveries: Array<{ channelId: string; ref: string; renderedAt: string }> }>
  sendMessage?: (input: { channels: string[] }) => Promise<{ deliveries: Array<{ channelId: string; ref: string; renderedAt: string }> }>
} = {}): PluginContext {
  return {
    assets: {
      resolveVersionFile: mock(opts.resolveVersionFile ?? (async (assetId: string): Promise<VersionFileRef | null> => ({ absPath: `/store/${assetId}/v1.png`, mimeType: 'image/png', version: 1 }))),
    },
    runtime: {
      channels: {
        deliverContent: mock(opts.deliverContent ?? (async ({ channels }) => ({
          deliveries: channels.map(channelId => ({ channelId, ref: `content-${channelId}`, renderedAt: new Date().toISOString() })),
        }))),
        sendMessage: mock(opts.sendMessage ?? (async ({ channels }) => ({
          deliveries: channels.map(channelId => ({ channelId, ref: `msg-${channelId}`, renderedAt: new Date().toISOString() })),
        }))),
      },
    },
    activity: {
      audit: mock(),
      log: mock(),
    },
  } as unknown as PluginContext
}

function withStore(test: (store: ReturnType<typeof createMessagingContentStorage>) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-publish-'))
  const store = createMessagingContentStorage(new MarkdownStorageAdapter(dir))
  const finish = () => rmSync(dir, { recursive: true, force: true })
  try {
    const result = test(store)
    if (result instanceof Promise) return result.finally(finish)
    finish()
  } catch (err) {
    finish()
    throw err
  }
}

describe('buildFilesFromDraft', () => {
  it('handles every assetRequirement value', async () => {
    const ctx = createCtx()

    expect((await buildFilesFromDraft(makeDeliverable(), contentType({ assetRequirement: 'none' }), ctx)).ok).toBe(true)
    expect((await buildFilesFromDraft(makeDeliverable(), contentType({ assetRequirement: 'optional-image' }), ctx)).ok).toBe(true)
    expect((await buildFilesFromDraft(makeDeliverable(), contentType({ assetRequirement: 'optional-video' }), ctx)).ok).toBe(true)

    const image = await buildFilesFromDraft(
      makeDeliverable({ draft: { imageAssetId: 'hero' } }),
      contentType({ assetRequirement: 'image' }),
      ctx,
    )
    expect(image.ok && image.files.map(file => file.path)).toEqual(['/store/hero/v1.png'])

    const video = await buildFilesFromDraft(
      makeDeliverable({ draft: { videoAssetId: 'clip' } }),
      contentType({ assetRequirement: 'video' }),
      ctx,
    )
    expect(video.ok && video.files.map(file => file.path)).toEqual(['/store/clip/v1.png'])
  })

  it('fails when required assets are missing', async () => {
    const ctx = createCtx()

    expect(await buildFilesFromDraft(makeDeliverable(), contentType({ assetRequirement: 'image' }), ctx)).toEqual({
      ok: false,
      reason: 'Required image asset missing on Deliverable',
    })
    expect(await buildFilesFromDraft(makeDeliverable(), contentType({ assetRequirement: 'video' }), ctx)).toEqual({
      ok: false,
      reason: 'Required video asset missing on Deliverable',
    })
  })

  it('resolves both image and video draft files when present', async () => {
    const ctx = createCtx()
    const result = await buildFilesFromDraft(
      makeDeliverable({ draft: { imageAssetId: 'hero', videoAssetId: 'clip' } }),
      contentType({ assetRequirement: 'none' }),
      ctx,
    )

    expect(result.ok && result.files.map(file => file.path)).toEqual(['/store/hero/v1.png', '/store/clip/v1.png'])
  })

  it('fails when an image or video asset cannot be resolved', async () => {
    const imageCtx = createCtx({ resolveVersionFile: async () => null })
    const image = await buildFilesFromDraft(
      makeDeliverable({ draft: { imageAssetId: 'hero' } }),
      contentType({ assetRequirement: 'optional-image' }),
      imageCtx,
    )
    expect(image.ok).toBe(false)
    expect(!image.ok && image.reason).toContain('Asset hero (image) not resolvable')

    const videoCtx = createCtx({ resolveVersionFile: async () => null })
    const video = await buildFilesFromDraft(
      makeDeliverable({ draft: { videoAssetId: 'clip' } }),
      contentType({ assetRequirement: 'optional-video' }),
      videoCtx,
    )
    expect(video.ok).toBe(false)
    expect(!video.ok && video.reason).toContain('Asset clip (video) not resolvable')
  })
})

describe('publishDeliverableNow', () => {
  it('delivers content, persists published metadata, and audits success', async () => withStore(async (store) => {
    const ctx = createCtx()
    const deliverable = store.createDeliverable({
      ...makeDeliverable({ draft: { caption: 'A published caption.', imageAssetId: 'hero' } }),
    })

    const result = await publishDeliverableNow(store, deliverable, contentType({ assetRequirement: 'optional-image' }), ctx)

    expect(result.ok).toBe(true)
    expect(result.ok && result.deliveryRef).toBe('content-general')
    const saved = store.getDeliverable(deliverable.id)!
    expect(saved.status).toBe('published')
    expect(saved.publishedDeliveryRef).toBe('content-general')
    expect(saved.publishedAt).toBeTruthy()
    expect(ctx.runtime.channels.deliverContent).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      content: expect.objectContaining({
        title: 'Taco post',
        body: 'A published caption.',
        files: [{ name: 'hero.png', path: '/store/hero/v1.png', contentType: 'image/png' }],
      }),
    }))
    expect(ctx.activity.audit).toHaveBeenCalledWith('deliverable.published', 'system', expect.objectContaining({ deliverableId: deliverable.id }))
  }))

  it('marks failed and notifies when asset validation fails', async () => withStore(async (store) => {
    const ctx = createCtx()
    const deliverable = store.createDeliverable({ ...makeDeliverable() })

    const result = await publishDeliverableNow(store, deliverable, contentType({ assetRequirement: 'image' }), ctx)

    expect(result.ok).toBe(false)
    const saved = store.getDeliverable(deliverable.id)!
    expect(saved.status).toBe('failed')
    expect(saved.failureReason).toBe('Required image asset missing on Deliverable')
    expect(saved.failureStage).toBe('validation')
    expect(saved.failedAt).toBeTruthy()
    expect(ctx.runtime.channels.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['general'],
      message: expect.objectContaining({ body: 'Required image asset missing on Deliverable' }),
    }))
  }))

  it('marks failed when deliverContent throws', async () => withStore(async (store) => {
    const ctx = createCtx({ deliverContent: async () => { throw new Error('channel offline') } })
    const deliverable = store.createDeliverable({ ...makeDeliverable() })

    const result = await publishDeliverableNow(store, deliverable, contentType(), ctx)

    expect(result.ok).toBe(false)
    const saved = store.getDeliverable(deliverable.id)!
    expect(saved.status).toBe('failed')
    expect(saved.failureReason).toBe('Channel delivery failed: channel offline')
    expect(saved.failureStage).toBe('delivery')
  }))

  it('marks failed when delivery returns no reference', async () => withStore(async (store) => {
    const ctx = createCtx({ deliverContent: async () => ({ deliveries: [] }) })
    const deliverable = store.createDeliverable({ ...makeDeliverable() })

    const result = await publishDeliverableNow(store, deliverable, contentType(), ctx)

    expect(result.ok).toBe(false)
    const saved = store.getDeliverable(deliverable.id)!
    expect(saved.status).toBe('failed')
    expect(saved.failureReason).toBe('Channel delivery did not return a delivery reference')
    expect(saved.failureStage).toBe('delivery')
  }))
})
