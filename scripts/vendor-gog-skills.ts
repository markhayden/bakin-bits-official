#!/usr/bin/env bun
/**
 * Vendor gog's agent skills into the google-workspace pack at an exact tag.
 *
 *   bun run scripts/vendor-gog-skills.ts v0.48.0
 *
 * The pack ships ONE entry skill (skills/google-workspace/SKILL.md, Bakin's
 * rules) and gog's own MIT skills verbatim as references the agent opens on
 * demand (provider-integrations spec D11). The tag MUST equal the pinned gog
 * binary version (`requires.bins[0].version`) — the pack contract test holds
 * the two together, so a pin bump re-runs this script in the same commit.
 *
 * Idempotent: the same tag writes the same bytes. Writes references/
 * VENDORED.json { tag, commit, fetchedAt, files: { name: sha256 } } and
 * keeps upstream's LICENSE beside them.
 */
import { createHash } from 'crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const REPO = 'openclaw/gogcli'
const SKILLS = ['gog', 'gog-gmail', 'gog-calendar', 'gog-drive', 'gog-docs', 'gog-sheets', 'gog-inbox-triage', 'gog-weekly-digest'] as const

const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: bun run scripts/vendor-gog-skills.ts v<major>.<minor>.<patch>')
  process.exit(2)
}

const packDir = join(import.meta.dir, '..', 'packs', 'google-workspace')
const refsDir = join(packDir, 'skills', 'google-workspace', 'references')

async function text(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.text()
}

const commit = (JSON.parse(await text(`https://api.github.com/repos/${REPO}/commits/${tag}`)) as { sha: string }).sha
const manifest = JSON.parse(await Bun.file(join(packDir, 'bakin-package.json')).text()) as { requires?: { bins?: Array<{ name: string; version: string }> } }
const pinned = manifest.requires?.bins?.find((bin) => bin.name === 'gog')?.version
if (pinned && `v${pinned}` !== tag) {
  console.error(`refusing: the pack pins gog ${pinned} but you asked for ${tag} — bump the bin pin in the same change`)
  process.exit(1)
}

rmSync(refsDir, { recursive: true, force: true })
mkdirSync(refsDir, { recursive: true })
const files: Record<string, string> = {}
for (const name of SKILLS) {
  const body = await text(`https://raw.githubusercontent.com/${REPO}/${tag}/.agents/skills/${name}/SKILL.md`)
  const file = `${name}.md`
  writeFileSync(join(refsDir, file), body)
  files[file] = createHash('sha256').update(body).digest('hex')
}
const license = await text(`https://raw.githubusercontent.com/${REPO}/${tag}/LICENSE`)
writeFileSync(join(refsDir, 'LICENSE'), license)
files.LICENSE = createHash('sha256').update(license).digest('hex')
writeFileSync(join(refsDir, 'VENDORED.json'), JSON.stringify({ repo: REPO, tag, commit, fetchedAt: new Date().toISOString().slice(0, 10), files }, null, 2) + '\n')
console.log(`vendored ${readdirSync(refsDir).length} files from ${REPO}@${tag} (${commit.slice(0, 12)}) into ${refsDir}`)
