import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT,
  copyPluginUiReports,
  pluginUiVerificationCommands,
  validateOfficialBitsPluginUiEnrollment,
} from '../scripts/verify-plugin-ui'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('official Bits plugin UI conformance enrollment', () => {
  it('names every current package and graduates the author template', () => {
    expect(validateOfficialBitsPluginUiEnrollment()).toEqual([])
    expect(OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT.find((entry) => entry.id === '_template')?.status).toBe('conformant')
    expect(OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT.find((entry) => entry.id === 'terminal')?.status).toBe('conformant')
    expect(OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT.find((entry) => entry.id === 'projects')?.status).toBe('conformant')
    expect(OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT.find((entry) => entry.id === 'messaging')?.status).toBe('conformant')
  })

  it('runs the installed-package harness in pinned Playwright CI', () => {
    const workflow = readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('mcr.microsoft.com/playwright:v1.60.0-noble')
    expect(workflow).toContain('BAKIN_SDK_PACKAGE_DIR: ${{ runner.temp }}/sdk-package')
    expect(workflow).toContain('run: bun run ui:conformance')
    expect(workflow).toContain('path: test-results/plugin-ui-conformance')
    // Workspace-dependent tests keep their root preload and stub SDK there.
    expect(workflow).toContain('run: bun run typecheck')
    expect(workflow).toContain('run: bun run test:coverage')
  })

  it('runs real SDK fixtures for workspace-tested packages and preserves standalone checks', () => {
    for (const entry of OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT) {
      if (entry.status !== 'conformant') continue
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', entry.root, 'package.json'), 'utf8'))
      const commands = pluginUiVerificationCommands(entry, pkg.scripts)
      const browser = [['run', 'test:ui']]
      if (entry.id === 'messaging') {
        browser.push(['run', 'test:ui:collections'])
        for (const surface of ['calendar', 'brainstorm', 'workspace']) {
          expect(pkg.scripts['test:ui:collections']).toContain(`MESSAGING_UI_SURFACE=${surface} bakin-plugin-test-ui --config tests/collection.ui-test.ts`)
        }
      }
      if (entry.id === 'projects') {
        browser.push(['run', 'test:ui:collections'])
        expect(pkg.scripts['test:ui:collections']).toBe('bakin-plugin-test-ui --config tests/plan.ui-test.ts && bakin-plugin-test-ui --config tests/detail.ui-test.ts && PROJECTS_UI_SURFACE=edit bakin-plugin-test-ui --config tests/detail.ui-test.ts && bun tests/detail.browser-test.ts')
      }
      const independent = entry.id === '_template' || entry.id === 'terminal'
      expect(commands).toEqual([
        ['install'], ...(independent ? [['run', 'typecheck'], ['test']] : []), ...browser,
      ])
    }
  })

  it('refuses missing collection coverage or a noncanonical primary command', () => {
    for (const id of ['messaging', 'projects']) {
      const entry = OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT.find(item => item.id === id)!
      if (entry.status !== 'conformant') throw new Error(`${id} must be enrolled`)
      expect(() => pluginUiVerificationCommands(entry, { 'test:ui': 'bakin-plugin-test-ui' })).toThrow('requires test:ui:collections')
      expect(() => pluginUiVerificationCommands(entry, { 'test:ui': 'echo skipped' })).toThrow('canonical test:ui')
    }
  })

  it('preserves primary and partial collection reports before scratch cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'bakin-bits-plugin-ui-reports-'))
    roots.push(root)
    const consumer = join(root, 'plugin')
    for (const name of ['bakin-ui', 'bakin-ui-calendar', 'bakin-ui-brainstorm']) {
      mkdirSync(join(consumer, 'test-results', name), { recursive: true })
      writeFileSync(join(consumer, 'test-results', name, 'index.html'), name)
    }
    const destination = join(root, 'artifacts/messaging')
    copyPluginUiReports(consumer, destination)
    expect(readFileSync(join(destination, 'index.html'), 'utf8')).toBe('bakin-ui')
    expect(readFileSync(join(destination, 'calendar/index.html'), 'utf8')).toBe('bakin-ui-calendar')
    expect(readFileSync(join(destination, 'brainstorm/index.html'), 'utf8')).toBe('bakin-ui-brainstorm')
    expect(() => copyPluginUiReports(join(root, 'not-created'), destination)).not.toThrow()
  })

  it('blocks a silent client package and a false server-only classification', () => {
    const root = mkdtempSync(join(tmpdir(), 'bakin-bits-plugin-ui-enrollment-'))
    roots.push(root)
    mkdirSync(join(root, 'plugins/new-plugin'), { recursive: true })
    writeFileSync(join(root, 'plugins/new-plugin/bakin-plugin.json'), JSON.stringify({ id: 'new-plugin' }))
    writeFileSync(join(root, 'plugins/new-plugin/client.tsx'), 'export {}\n')

    expect(validateOfficialBitsPluginUiEnrollment(root, [])).toContain(
      'plugins/new-plugin is missing from official plugin UI enrollment',
    )
    expect(validateOfficialBitsPluginUiEnrollment(root, [{
      id: 'new-plugin',
      root: 'plugins/new-plugin',
      status: 'server-only',
      reason: 'Incorrect seeded classification.',
    }])).toContain('new-plugin is labeled server-only but has a browser client entrypoint')
  })
})
