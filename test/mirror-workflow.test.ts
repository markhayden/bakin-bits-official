/**
 * The tmux binary mirror (RELEASE.md § Binary mirrors): reproducible from
 * pinned sources, native slices on both architectures, one universal asset,
 * released under mirror/tmux-v<v> and never marked latest.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

const root = join(import.meta.dir, '..')
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/mirror-tmux.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } }
  jobs: Record<string, { needs?: string; 'runs-on'?: string; strategy?: { matrix: { include: Array<{ runner: string; arch: string }> } }; steps: Array<{ name: string; run?: string; uses?: string }> }>
}
const sources = JSON.parse(readFileSync(join(root, 'scripts/mirror/tmux-sources.json'), 'utf8')) as {
  tmux: Record<string, { sha256: string }>
  deps: Record<string, { version: string; url: string; sha256: string }>
}
const HEX64 = /^[0-9a-f]{64}$/

describe('mirror-tmux workflow', () => {
  it('is dispatch-only with a required version input', () => {
    expect(workflow.on.workflow_dispatch.inputs.version?.required).toBe(true)
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  })

  it('builds native slices on an arm64 and an intel runner, then packages on top of both', () => {
    const include = workflow.jobs.build.strategy!.matrix.include
    expect(include.map((leg) => `${leg.runner}:${leg.arch}`).sort()).toEqual(['macos-14:arm64', 'macos-15-intel:x86_64'])
    expect(workflow.jobs.package.needs).toBe('build')
    expect(workflow.jobs.build.steps.some((s) => s.run?.includes('scripts/mirror/build-tmux.sh'))).toBe(true)
  })

  it('refuses an unpinned version and an existing tag, and releases mirror/tmux-v<v> without marking it latest', () => {
    const buildRuns = workflow.jobs.build.steps.map((s) => s.run ?? '').join('\n')
    expect(buildRuns).toContain('tmux-sources.json')
    const packageRuns = workflow.jobs.package.steps.map((s) => s.run ?? '').join('\n')
    expect(packageRuns).toContain('gh release view "$TAG"')
    expect(packageRuns).toContain('--latest=false')
    expect(packageRuns).toContain('lipo -create')
    expect(packageRuns).toContain("otool -L")
    expect(packageRuns).toContain('codesign --force -s -')
    expect(packageRuns).toContain('BUILD.json')
    expect(packageRuns).toContain('.sha256')
    const env = (workflow.jobs.package as unknown as { env: Record<string, string> }).env
    expect(env.TAG).toBe('mirror/tmux-v${{ inputs.version }}')
  })
})

describe('pinned mirror sources', () => {
  it('every tmux version and dependency carries a 64-hex sha256 and an https URL', () => {
    expect(Object.keys(sources.tmux).length).toBeGreaterThan(0)
    for (const [version, pin] of Object.entries(sources.tmux)) {
      expect(version).toMatch(/^\d+\.\d+[a-z]?$/)
      expect(pin.sha256).toMatch(HEX64)
    }
    expect(Object.keys(sources.deps).sort()).toEqual(['libevent', 'ncurses', 'utf8proc'])
    for (const dep of Object.values(sources.deps)) {
      expect(dep.url).toMatch(/^https:\/\//)
      expect(dep.sha256).toMatch(HEX64)
    }
  })

  it('the build script exists, is executable, and verifies every download against the pins', () => {
    const script = join(root, 'scripts/mirror/build-tmux.sh')
    expect(existsSync(script)).toBe(true)
    expect(statSync(script).mode & 0o111).not.toBe(0)
    const body = readFileSync(script, 'utf8')
    expect(body).toContain('checksum mismatch')
    expect(body).toContain('--enable-widec')
    expect(body).toContain('--enable-utf8proc')
    expect(body).toContain('codesign --force -s -')
    expect(body).toContain('capture-pane')
  })
})
