/**
 * Contract tests for the root catalog.json — the storefront index Bakin's
 * Explore plugin fetches from raw.githubusercontent.com on user-triggered
 * refresh (schema v2, defined in Bakin at src/core/curated-catalog/schema.ts).
 *
 * The catalog must never drift from the repo: every entry's source must
 * point at a real package directory here, and every iconUrl must reference
 * a file that actually exists in this repo.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const RAW_BASE = 'https://raw.githubusercontent.com/markhayden/bakin-bits-official/main/'

interface CatalogEntry {
  id: string
  kind: string
  name: string
  description: string
  category: string
  tags?: string[]
  useCases?: string[]
  source?: string
  trust?: string
  builtin?: boolean
  iconUrl?: string
  screenshots?: string[]
  dependencies?: string[]
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf-8')) as {
  version: number
  updatedAt: string
  entries: CatalogEntry[]
}

const KINDS = new Set(['agent', 'plugin', 'skill-pack', 'workflow-pack', 'lesson-pack'])
const KIND_DIRS: Record<string, string> = { agent: 'agents', plugin: 'plugins' }

function packageDirs(parent: string): string[] {
  return readdirSync(join(ROOT, parent), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
}

describe('catalog.json structure', () => {
  it('is schema v2 with a non-empty entry list', () => {
    expect(catalog.version).toBe(2)
    expect(typeof catalog.updatedAt).toBe('string')
    expect(catalog.entries.length).toBeGreaterThan(0)
  })

  it('every entry has the required storefront fields', () => {
    for (const entry of catalog.entries) {
      expect(entry.id.length).toBeGreaterThan(0)
      expect(KINDS.has(entry.kind)).toBe(true)
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.category.length).toBeGreaterThan(0)
      expect((entry.useCases ?? []).length).toBeGreaterThan(0)
      expect(entry.trust).toBe('official')
    }
  })

  it('never declares builtin entries — those are Bakin-embedded only', () => {
    expect(catalog.entries.every((entry) => entry.builtin !== true)).toBe(true)
  })
})

describe('catalog.json ↔ repo consistency', () => {
  it('every source points at a real package directory in this repo', () => {
    for (const entry of catalog.entries) {
      expect(entry.source?.startsWith('github:markhayden/bakin-bits-official#')).toBe(true)
      const subpath = entry.source!.split('#')[1]
      expect(existsSync(join(ROOT, subpath))).toBe(true)
    }
  })

  it('covers every published agent and plugin package', () => {
    const agents = catalog.entries.filter((e) => e.kind === 'agent').map((e) => e.id).sort()
    const plugins = catalog.entries.filter((e) => e.kind === 'plugin').map((e) => e.id).sort()
    expect(agents).toEqual(packageDirs('agents').sort())
    expect(plugins).toEqual(packageDirs('plugins').sort())
  })

  it('entry id and name match the package manifest', () => {
    // Descriptions may intentionally differ — the catalog is storefront
    // copy (plain-English), manifests are technical source of truth.
    for (const entry of catalog.entries) {
      const subpath = entry.source!.split('#')[1]
      // Plugins ship bakin-plugin.json; every package kind (agent, skill-pack,
      // workflow-pack, lesson-pack) ships bakin-package.json.
      const manifestName = entry.kind === 'plugin' ? 'bakin-plugin.json' : 'bakin-package.json'
      const manifest = JSON.parse(readFileSync(join(ROOT, subpath, manifestName), 'utf-8')) as {
        id: string
        name: string
      }
      expect(entry.id).toBe(manifest.id)
      expect(entry.name).toBe(manifest.name)
    }
  })

  it('every iconUrl and screenshot points at a file that exists in this repo', () => {
    for (const entry of catalog.entries) {
      for (const url of [entry.iconUrl, ...(entry.screenshots ?? [])]) {
        if (!url) continue
        expect(url.startsWith(RAW_BASE)).toBe(true)
        expect(existsSync(join(ROOT, url.slice(RAW_BASE.length)))).toBe(true)
      }
    }
  })

  it('every agent entry ships an iconUrl (storefront avatars)', () => {
    for (const entry of catalog.entries.filter((e) => e.kind === 'agent')) {
      expect(entry.iconUrl?.length).toBeGreaterThan(0)
    }
  })
})
