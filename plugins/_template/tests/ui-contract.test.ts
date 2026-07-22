import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const TEMPLATE_ROOT = resolve(import.meta.dir, '..')

function read(path: string): string {
  return readFileSync(resolve(TEMPLATE_ROOT, path), 'utf8')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (['dist', 'node_modules', 'test-results'].includes(entry.name)) return []
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('official plugin UI template contract', () => {
  it('uses the modern plugin-owned route and a real host slot', () => {
    const registration = read('client-registration.tsx')
    const client = read('client.tsx')
    const manifest = JSON.parse(read('bakin-plugin.json')) as {
      contributes?: {
        clientRoutes?: Array<{ path?: string }>
        routes?: Array<{ path?: string }>
        slots?: string[]
      }
    }

    expect(registration).toContain("routes: { '/_template': TemplatePage }")
    expect(registration).toContain("'home-widget': TemplateWidget")
    expect(client).toContain('registerPlugin(templateRegistration)')
    expect(manifest.contributes?.routes).toContainEqual(expect.objectContaining({ path: '/_template' }))
    expect(manifest.contributes?.clientRoutes).toContainEqual(expect.objectContaining({ path: '/_template' }))
    expect(manifest.contributes?.slots).toContain('home-widget')
    expect(manifest.contributes?.slots).not.toContain('page:/_template')
  })

  it('uses focused Storybook contracts with no private styling access', () => {
    const browser = sourceFiles(TEMPLATE_ROOT)
      .filter((path) => !path.includes(`${join('tests', '')}`) && !path.endsWith('bakin.ui-test.ts'))
      .filter((path) => path.endsWith('.tsx') || path.endsWith('.css'))
      .map((path) => ({ path: relative(TEMPLATE_ROOT, path), source: readFileSync(path, 'utf8') }))

    expect(browser.some(({ source }) => source.includes("from '@makinbakin/sdk/layout'"))).toBe(true)
    expect(browser.some(({ source }) => source.includes("from '@makinbakin/sdk/patterns'"))).toBe(true)
    expect(browser.some(({ source }) => source.includes("from '@makinbakin/sdk/ui'"))).toBe(true)
    expect(browser.some(({ source }) => source.includes("from '@makinbakin/sdk/navigation'"))).toBe(true)

    const violations = browser.flatMap(({ path, source }) => {
      const findings: string[] = []
      if (source.includes('@makinbakin/sdk/components')) findings.push(`${path}: legacy components barrel`)
      if (/<(?:button|details|input|select|summary|textarea)\b/.test(source)) findings.push(`${path}: raw standard control`)
      if (/@bakin\/|@\/|(?:^|\/)packages\/(?:host|core)/m.test(source)) findings.push(`${path}: private import`)
      if (/className=["'][^"']*(?:\b(?:p|m|gap|space|text|bg|border|rounded|flex|grid|w|h|min|max)-)/.test(source)) {
        findings.push(`${path}: host utility styling`)
      }
      return findings
    })

    expect(violations).toEqual([])
    expect(read('styles.css')).toMatch(
      /:where\(\[data-bakin-plugin=["']_template["']\]\)/,
    )
  })

  it('ships the copyable conformance and explicit deviation workflow', () => {
    const fixture = read('tests/ui.fixture.tsx')
    const config = read('bakin.ui-test.ts')
    const readme = read('README.md')
    const pkg = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(fixture).toContain('registrations={[templateRegistration]}')
    expect(fixture).toContain("slots={[{ name: 'home-widget'")
    expect(fixture.match(/@makinbakin\/sdk\/styles\.css/g)).toHaveLength(1)
    expect(config).toContain("fixtureEntry: './tests/ui.fixture.tsx'")
    expect(pkg.scripts?.['test:ui']).toBe('bakin-plugin-test-ui')
    expect(pkg.devDependencies?.['axe-core']).toBeDefined()
    expect(pkg.devDependencies?.playwright).toBeDefined()
    expect(readme).toContain('human-readable explanation')
    expect(readme).toContain('bun run test:ui')
  })

  it('uses the declarative server route contract', () => {
    const server = read('index.ts')

    expect(server).toContain("import { definePlugin, defineRoute } from '@makinbakin/sdk'")
    expect(server).toContain('routes: [')
    expect(server).not.toContain('ctx.registerRoute(')
  })
})
