import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT,
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
  })

  it('runs the installed-package harness in pinned Playwright CI', () => {
    const workflow = readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('mcr.microsoft.com/playwright:v1.60.0-noble')
    expect(workflow).toContain('BAKIN_SDK_PACKAGE_DIR: ${{ runner.temp }}/sdk-package')
    expect(workflow).toContain('run: bun run ui:conformance')
    expect(workflow).toContain('path: test-results/plugin-ui-conformance')
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
