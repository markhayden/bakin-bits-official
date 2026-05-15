import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import messagingPlugin from '../index'
import { createTestContext } from '../test-helpers'
import {
  loadMessagingDefaultWorkflowDefinitions,
  registerMessagingDefaultWorkflows,
} from '../lib/default-workflows'

const defaultsDir = join(process.cwd(), 'plugins', 'messaging', 'defaults', 'workflows')

function withTestDir<T>(prefix: string, test: (dir: string) => T | Promise<T>): T | Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    const result = test(dir)
    if (result instanceof Promise) {
      return result.finally(() => rmSync(dir, { recursive: true, force: true }))
    }
    rmSync(dir, { recursive: true, force: true })
    return result
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

describe('messaging default workflows', () => {
  it('loads the three shipped workflow YAML files as valid definitions', () => {
    const definitions = loadMessagingDefaultWorkflowDefinitions(defaultsDir)

    expect(definitions.map(definition => definition.id)).toEqual([
      'messaging-blog-prep',
      'messaging-image-post-prep',
      'messaging-video-prep',
    ])
    expect(definitions.every(definition => definition.errors.length === 0)).toBe(true)
    for (const { definition } of definitions) {
      expect(definition.steps.length).toBeGreaterThanOrEqual(3)
      expect(definition.steps.some(step => (step as { type?: string }).type === 'gate')).toBe(true)
      const agentSteps = definition.steps.filter(step => (step as { type?: string }).type === 'agent')
      expect(agentSteps.every(step => (step as { agent?: string }).agent === '$assigned')).toBe(true)
    }
  })

  it('registers valid defaults under filename-derived ids', () => {
    withTestDir('bakin-messaging-workflows-', (dir) => {
      const { ctx } = createTestContext('messaging', dir)
      const log = { warn: mock() }

      const result = registerMessagingDefaultWorkflows(ctx, defaultsDir, log)

      expect(result.skipped).toEqual([])
      expect(result.registered).toEqual([
        'messaging-blog-prep',
        'messaging-image-post-prep',
        'messaging-video-prep',
      ])
      expect(ctx.registerWorkflow).toHaveBeenCalledTimes(3)
      expect(ctx.registerWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        id: 'messaging-blog-prep',
        name: 'Messaging - Blog Prep',
      }))
    })
  })

  it('registers default workflows during plugin activation', async () => {
    await withTestDir('bakin-messaging-activate-workflows-', async (dir) => {
      const { ctx } = createTestContext('messaging', dir)

      await messagingPlugin.activate(ctx)

      expect(ctx.registerWorkflow).toHaveBeenCalledTimes(3)
      expect(ctx.registerWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'messaging-video-prep' }))
    })
  })
})
