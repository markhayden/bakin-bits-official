/**
 * Entity links are built from the owning plugin's manifest declaration
 * (`entityHref` from `@makinbakin/sdk/navigation`), never written out by hand.
 *
 * The banned shapes come from what Bakin's core plugins declare plus what the
 * plugins here declare: a template or concatenation that starts with a
 * declared href's prefix and puts an id straight after it
 * (`\`/projects/\${id}\``, `'/tasks?taskId=' + id`). A different route that
 * shares the prefix (`/projects/new`, a client route pattern) is allowed.
 *
 * Covers every official plugin here: Projects, Messaging and Terminal.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const PLUGINS = import.meta.dir
const SCANNED = ['projects', 'messaging', 'terminal']

/** The core kinds' prefixes (Bakin's manifests are not in this repo). */
const CORE_PREFIXES = ['/tasks?taskId=', '/assets/', '/schedule?jobId=', '/workflows/', '/brands/', '/chat/', '/team/']

function declaredPrefixes(): string[] {
  const prefixes = new Set(CORE_PREFIXES)
  for (const id of readdirSync(PLUGINS)) {
    const manifestPath = join(PLUGINS, id, 'bakin-plugin.json')
    if (id.startsWith('_') || !existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { contributes?: { entities?: Array<{ href: string }> } }
    for (const entity of manifest.contributes?.entities ?? []) prefixes.add(entity.href.slice(0, entity.href.indexOf('{')))
  }
  return [...prefixes]
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function findHandBuiltEntityHrefs(source: string, prefixes: readonly string[]): string[] {
  const found: string[] = []
  for (const prefix of prefixes) {
    for (const match of source.matchAll(new RegExp(`\`${escape(prefix)}\\$\\{[^\`]*\``, 'g'))) {
      const afterId = match[0].slice(match[0].indexOf('}', prefix.length) + 1)
      if (/^\/[a-z]/.test(afterId)) continue // a sub-route past the id
      found.push(match[0])
    }
    for (const match of source.matchAll(new RegExp(`['"]${escape(prefix)}['"]\\s*\\+`, 'g'))) found.push(match[0])
  }
  return found
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['dist', 'node_modules', 'tests', 'test-results'].includes(entry.name) ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|fixture)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('no hand-built entity links', () => {
  const prefixes = declaredPrefixes()

  test('the scanner knows the core kinds and the kinds declared here', () => {
    expect(prefixes).toEqual(expect.arrayContaining([...CORE_PREFIXES, '/projects/', '/messaging/plans/', '/messaging/brainstorm?session=']))
  })

  test('the scanner catches templates and concatenations, and lets other routes through', () => {
    const sample = [
      'router.push(`/projects/${encodeURIComponent(id)}`)',
      "const href = '/tasks?taskId=' + taskId",
      'to={`/messaging/brainstorm?session=${id}`}',
      "router.push('/projects/new')",
      "'/projects/[id]': ProjectDetailRoute,",
      'router.push(`/workflows/${id}/edit`)',
    ].join('\n')
    expect(findHandBuiltEntityHrefs(sample, prefixes).sort()).toEqual([
      "'/tasks?taskId=' +",
      '`/messaging/brainstorm?session=${id}`',
      '`/projects/${encodeURIComponent(id)}`',
    ])
  })

  test('no official plugin builds an entity link by hand', () => {
    const offenders: string[] = []
    for (const plugin of SCANNED) {
      for (const file of sourceFiles(join(PLUGINS, plugin))) {
        for (const hit of findHandBuiltEntityHrefs(readFileSync(file, 'utf8'), prefixes)) {
          offenders.push(`${file.slice(PLUGINS.length + 1)}: ${hit}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
