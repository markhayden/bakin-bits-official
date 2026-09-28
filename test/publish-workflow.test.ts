import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

const workflow = yaml.load(readFileSync(join(import.meta.dir, '../.github/workflows/publish.yml'), 'utf8')) as {
  on: { push: { tags: string[] } }
  jobs: { publish: { steps: Array<{ name: string; if?: string; run?: string }> } }
}
const steps = workflow.jobs.publish.steps
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('publish workflow SDK stylesheet sources', () => {
  it('exposes the tagged Bits checkout beside Bakin before SDK assembly, for plugins only', () => {
    const setupIndex = steps.findIndex((step) => step.name === "Expose Bits at Bakin's sibling path")
    expect(setupIndex).toBeGreaterThan(-1)
    expect(setupIndex).toBeGreaterThan(steps.findIndex((step) => step.name === 'Get Bakin (publish tool + SDK source)'))
    expect(setupIndex).toBeLessThan(steps.findIndex((step) => step.name === 'Assemble the current SDK'))
    const setup = steps[setupIndex]
    expect(setup.if).toBe("steps.tag.outputs.kind == 'plugin'")
    expect(setup.run).toBeDefined()

    const root = mkdtempSync(join(tmpdir(), 'bits-publish-sources-'))
    roots.push(root)
    const runnerTemp = join(root, 'runner temp')
    const workspace = join(root, 'tagged checkout')
    mkdirSync(join(runnerTemp, 'bakin'), { recursive: true })
    mkdirSync(join(workspace, 'plugins/projects'), { recursive: true })

    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', setup.run!], {
      env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: workspace },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(realpathSync(join(runnerTemp, 'bakin-bits-official/plugins/projects'))).toBe(
      realpathSync(join(workspace, 'plugins/projects')),
    )
  })
})

describe('publish workflow tag trigger', () => {
  it('fires for <id>-v<semver> tags and never for binary mirrors (mirror/**)', () => {
    expect(workflow.on.push.tags).toContain('*-v*')
    expect(workflow.on.push.tags).toContain('!mirror/**')
  })
})
