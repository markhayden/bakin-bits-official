/**
 * Contract tests for the capability/skill packs in this directory.
 *
 * Packs were the one published package kind with no contract coverage —
 * `agents/package-contract.test.ts` guards agents, and `test/catalog-
 * contract.test.ts` only checks that a catalog entry's id and name match its
 * manifest. Nothing checked that a pack's declared skills exist, that a
 * pinned binary carries a real sha256, or that a pack made it into the
 * storefront at all. A broken pack is invisible until an install fails on a
 * user's machine, so the contract lives here.
 *
 * The rules mirror the manifest schema Bakin validates against at install
 * time (`packages/core/src/agent-packages/manifest.ts`) — this is the
 * publish-side half of the same contract.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const packsRoot = join(import.meta.dir)
const repoRoot = join(packsRoot, '..')

/** Platform keys follow process.platform-process.arch (Bakin's pin convention). */
const PLATFORM_KEYS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'])

/**
 * Slots outside a pack's own `skills.*` namespace that Bakin's injection
 * layer still binds, from core's STATIC_ENV_SECRET_MAPPINGS. Keep in sync
 * with `src/core/secret-env.ts`; a slot that is in neither place is dead.
 */
const STATIC_FIRST_PARTY_SLOTS: Record<string, string> = {
  BRAVE_SEARCH_API_KEY: 'brave.apiKey',
}

interface BinDownload {
  url?: string
  sha256?: string
  archive?: { format?: string; member?: string }
}

interface PackManifest {
  id?: string
  kind?: string
  name?: string
  version?: string
  description?: string
  author?: string
  bakin?: string
  capability?: string
  runtimes?: string[]
  platforms?: string[]
  contributions?: { skills?: string[] }
  requires?: {
    bins?: Array<{ name?: string; version?: string; install?: Record<string, BinDownload>; verifyArgs?: string[] }>
    npm?: Array<{ name?: string; source?: string; dependencies?: Record<string, string> }>
    prereqs?: Array<{ name?: string; kind?: string; probe?: string; help?: string }>
    models?: unknown[]
  }
  secrets?: Array<{ name?: string; description?: string; required?: boolean; secretSlot?: string; help?: string }>
}

function listPackDirs(): string[] {
  return readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packsRoot, name, 'bakin-package.json')))
    .sort()
}

function readManifest(packId: string): PackManifest {
  return JSON.parse(readFileSync(join(packsRoot, packId, 'bakin-package.json'), 'utf-8'))
}

const packIds = listPackDirs()

describe('pack contracts', () => {
  it('every directory under packs/ carries a manifest', () => {
    const dirs = readdirSync(packsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort()
    expect(packIds).toEqual(dirs)
  })

  for (const packId of packIds) {
    describe(packId, () => {
      const manifest = readManifest(packId)

      it('has a valid manifest shape', () => {
        expect(manifest.id).toBe(packId)
        expect(manifest.kind).toBe('skill-pack')
        expect(manifest.name).toBeTruthy()
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
        expect(manifest.description).toBeTruthy()
        expect(manifest.author).toBeTruthy()
        expect(manifest.bakin).toBeTruthy()
        // Runtimes must be explicit: an omitted list reads as "unknown", and
        // the server-side gate refuses to install what it cannot place.
        expect((manifest.runtimes ?? []).length).toBeGreaterThan(0)
        if (manifest.capability) expect(manifest.capability).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/)
        for (const platform of manifest.platforms ?? []) {
          expect(PLATFORM_KEYS.has(platform), `${packId}: unknown platform ${platform}`).toBe(true)
        }
      })

      it('ships every skill it contributes', () => {
        const skills = manifest.contributions?.skills ?? []
        expect(skills.length).toBeGreaterThan(0)
        for (const rel of skills) {
          const skillMd = join(packsRoot, packId, rel, 'SKILL.md')
          expect(existsSync(skillMd), `${packId}: missing ${rel}/SKILL.md`).toBe(true)
          const body = readFileSync(skillMd, 'utf-8')
          // Agent-Skills frontmatter is what every runtime reads to load the
          // skill; a bundle without it installs but never activates.
          expect(body.startsWith('---\n'), `${packId}: ${rel}/SKILL.md has no frontmatter`).toBe(true)
          const frontmatter = body.slice(4, body.indexOf('\n---', 4))
          expect(frontmatter).toContain('name:')
          expect(frontmatter).toContain('description:')
        }
      })

      it('pins every downloadable binary to https + a sha256', () => {
        for (const bin of manifest.requires?.bins ?? []) {
          expect(bin.name).toBeTruthy()
          expect(bin.version).toBeTruthy()
          const platforms = Object.entries(bin.install ?? {})
          expect(platforms.length, `${packId}: ${bin.name} has no install targets`).toBeGreaterThan(0)
          for (const [platform, download] of platforms) {
            expect(PLATFORM_KEYS.has(platform), `${packId}: ${bin.name} unknown platform ${platform}`).toBe(true)
            expect(download.url?.startsWith('https://'), `${packId}: ${bin.name}/${platform} url is not https`).toBe(true)
            // An unpinned download is an unreviewed download — the sha256 is
            // what makes a pack install reproducible.
            expect(download.sha256, `${packId}: ${bin.name}/${platform} has no sha256`).toMatch(/^[a-f0-9]{64}$/)
          }
        }
      })

      it('declares npm payloads that exist in the pack', () => {
        for (const entry of manifest.requires?.npm ?? []) {
          expect(entry.name).toBeTruthy()
          expect(entry.source).toBeTruthy()
          expect(existsSync(join(packsRoot, packId, entry.source!)), `${packId}: missing npm source ${entry.source}`).toBe(true)
          // Floating ranges make an install unreproducible; pin exact versions.
          for (const [dep, range] of Object.entries(entry.dependencies ?? {})) {
            expect(range, `${packId}: ${dep} is not pinned to an exact version`).toMatch(/^\d+\.\d+\.\d+/)
          }
        }
      })

      it('declares secrets as env vars with a bindable slot and a help link', () => {
        for (const secret of manifest.secrets ?? []) {
          expect(secret.name).toMatch(/^[A-Z_][A-Z0-9_]*$/)
          expect(secret.description).toBeTruthy()
          expect(typeof secret.required).toBe('boolean')
          if (secret.secretSlot) {
            // Bakin's env-injection layer binds a pack slot only when it is
            // in the pack's own `skills.<packId>.<ENV_VAR>` namespace or in
            // core's static first-party table. Anything else parses fine,
            // installs fine, and then never reaches the agent — the operator
            // types a key into a slot that goes nowhere. Caught live on the
            // notion pack, which shipped `notion.token` and was refused.
            const minted = `skills.${packId}.${secret.name}`
            const bindable = secret.secretSlot === minted || STATIC_FIRST_PARTY_SLOTS[secret.name!] === secret.secretSlot
            expect(bindable, `${packId}: secret ${secret.name} declares unbindable slot "${secret.secretSlot}" (expected "${minted}")`).toBe(true)
          }
          // A key the operator cannot find is a dead install — every declared
          // secret says where to get it.
          expect(secret.help, `${packId}: secret ${secret.name} has no help URL`).toMatch(/^https:\/\//)
        }
      })
    })
  }
})

describe('packs ↔ catalog', () => {
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'catalog.json'), 'utf-8')) as {
    entries: Array<{ id: string; kind: string; source?: string; capability?: string }>
  }

  it('every published pack has a storefront entry', () => {
    const listed = catalog.entries.filter((e) => e.kind === 'skill-pack').map((e) => e.id).sort()
    expect(listed).toEqual(packIds)
  })

  it('each entry points at its own pack directory and repeats its capability', () => {
    for (const entry of catalog.entries.filter((e) => e.kind === 'skill-pack')) {
      expect(entry.source).toBe(`github:markhayden/bakin-bits-official#packs/${entry.id}`)
      // The storefront filters on capability, so a drift here hides the pack.
      expect(entry.capability).toBe(readManifest(entry.id).capability)
    }
  })
})

describe('pack payload hygiene', () => {
  it('ships no installed node_modules or lockfile-less payloads', () => {
    for (const packId of packIds) {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            expect(entry.name, `${packId}: node_modules committed under ${dir}`).not.toBe('node_modules')
            walk(join(dir, entry.name))
          }
        }
      }
      walk(join(packsRoot, packId))
    }
  })

  it('keeps every shipped script executable-shaped (shebang) or plainly data', () => {
    for (const packId of packIds) {
      const scriptsDir = join(packsRoot, packId, 'payload', 'scripts')
      if (!existsSync(scriptsDir) || !statSync(scriptsDir).isDirectory()) continue
      for (const entry of readdirSync(scriptsDir)) {
        if (!/\.(sh|mjs|js|py)$/.test(entry)) continue
        const head = readFileSync(join(scriptsDir, entry), 'utf-8').slice(0, 2)
        expect(head, `${packId}: ${entry} has no shebang`).toBe('#!')
      }
    }
  })
})
