import { describe, expect, it, mock } from 'bun:test'
import { DEFAULT_CONTENT_TYPES } from '../types'
import { normalizeContentTypes } from '../lib/content-types'

describe('normalizeContentTypes', () => {
  it('seeds canonical defaults when no content types exist', async () => {
    const result = await normalizeContentTypes(undefined, {
      workflowExists: () => true,
    })

    expect(result.changed).toBe(true)
    expect(result.contentTypes).toEqual(DEFAULT_CONTENT_TYPES)
  })

  it('fills missing new fields for shipped default ids while preserving user edits', async () => {
    const result = await normalizeContentTypes([
      { id: 'blog', label: 'Kitchen notes', defaultAgent: 'basil' },
      { id: 'custom', label: 'Custom type' },
    ], {
      workflowExists: () => true,
    })

    expect(result.contentTypes[0]).toMatchObject({
      id: 'blog',
      label: 'Kitchen notes',
      defaultAgent: 'basil',
      prepLeadHours: 72,
      assetRequirement: 'optional-image',
      workflowId: 'messaging-blog-prep',
    })
    expect(result.contentTypes[1]).toEqual({ id: 'custom', label: 'Custom type' })
  })

  it('preserves user-cleared workflowId while filling other defaults', async () => {
    const result = await normalizeContentTypes([
      { id: 'video', label: 'Video', workflowId: '' },
    ], {
      workflowExists: () => true,
    })

    expect(result.contentTypes[0]).toMatchObject({
      id: 'video',
      workflowId: '',
      prepLeadHours: 168,
      assetRequirement: 'video',
    })
  })

  it('clears unavailable workflow definitions and reports them', async () => {
    const onMissingWorkflow = mock()
    const result = await normalizeContentTypes([
      { id: 'blog', label: 'Blog post' },
      { id: 'video', label: 'Video' },
    ], {
      workflowExists: workflowId => workflowId === 'messaging-blog-prep',
      onMissingWorkflow,
    })

    expect(result.contentTypes[0].workflowId).toBe('messaging-blog-prep')
    expect(result.contentTypes[1].workflowId).toBeUndefined()
    expect(onMissingWorkflow).toHaveBeenCalledWith('video', 'messaging-video-prep')
  })
})
