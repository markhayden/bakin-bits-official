import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

type Download = { url: string; sha256: string; sizeBytes?: number; archive?: { format: string; member: string } }
type Manifest = { id: string; requires?: { bins?: { name: string; version: string; install?: Record<string, Download>; verifyArgs?: string[] }[] } }
const plugins = join(import.meta.dir, '../plugins')
const manifests = readdirSync(plugins, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry =>
  JSON.parse(readFileSync(join(plugins, entry.name, 'bakin-plugin.json'), 'utf8')) as Manifest,
)

test('plugin binary downloads pin secure immutable artifacts', () => {
  for (const manifest of manifests) for (const bin of manifest.requires?.bins ?? []) {
    expect(bin.name).toMatch(/^[a-zA-Z0-9._-]+$/)
    expect(bin.version.length).toBeGreaterThan(0)
    for (const download of Object.values(bin.install ?? {})) {
      const url = new URL(download.url)
      expect(url.protocol).toBe('https:')
      expect(download.sha256).toMatch(/^[0-9a-f]{64}$/)
      if (url.hostname === 'github.com' && url.pathname.startsWith('/markhayden/bakin-bits-official/')) {
        expect(url.pathname).toContain('/releases/download/mirror/')
      }
      if (download.sizeBytes !== undefined) expect(download.sizeBytes).toBeGreaterThan(0)
      if (download.archive) {
        expect(download.archive.format).toBe('tar.gz')
        expect(download.archive.member).not.toMatch(/(^\/|(^|\/)\.\.($|\/))/)
      }
    }
  }
})

test('Terminal installs the same pinned tmux on Apple Silicon and Intel Macs', () => {
  const terminal = manifests.find(manifest => manifest.id === 'terminal')!
  const tmux = terminal.requires?.bins?.find(bin => bin.name === 'tmux')
  expect(tmux).toBeDefined()
  expect(tmux!.version).toBe('3.7c')
  expect(tmux!.verifyArgs).toEqual(['-V'])
  expect(Object.keys(tmux!.install!).sort()).toEqual(['darwin-arm64', 'darwin-x64'])
  expect(tmux!.install!['darwin-arm64']).toEqual(tmux!.install!['darwin-x64'])
  expect(tmux!.install!['darwin-arm64'].archive?.member).toBe('tmux')
})
