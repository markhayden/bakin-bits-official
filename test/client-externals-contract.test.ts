/** The client-bundle loadability guard (bakin #948): parsed imports, unprovided host sub-paths, inlined zod. */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_EXTERNAL, clientBundleProblem, unprovidedHostSubpath } from '../scripts/client-externals'

/** CI checks out the pinned Bakin at .bakin-source; locally BAKIN_SOURCE_DIR may point at a checkout. */
const BAKIN_SOURCE = process.env.BAKIN_SOURCE_DIR ?? join(import.meta.dir, '..', '.bakin-source')
const EXTERNALS_TS = join(BAKIN_SOURCE, 'src/core/whiskit/externals.ts')

function bakinClientExternals(): string[] | null {
  if (!existsSync(EXTERNALS_TS)) return null
  const source = readFileSync(EXTERNALS_TS, 'utf8')
  const list = (name: string): string[] => {
    // Single-line (`= ['zod']`) and multi-line lists alike: up to the first closing bracket.
    const block = source.match(new RegExp(`export const ${name}: string\\[\\] = \\[([\\s\\S]*?)\\]`))
    if (!block) throw new Error(`${name} not found in ${EXTERNALS_TS}`)
    return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  }
  return [...list('REACT_EXTERNALS'), ...list('SDK_EXTERNALS'), ...list('ZOD_EXTERNALS')]
}

describe('lockstep with bakin', () => {
  const expected = bakinClientExternals()
  // CI runs this file with BAKIN_REQUIRE_SOURCE=1 while .bakin-source exists
  // (before the checkout is removed for the coverage run), so the comparison
  // is never silently skipped there; locally it skips without a checkout.
  const required = process.env.BAKIN_REQUIRE_SOURCE === '1'
  test.if(expected !== null || required)('CLIENT_EXTERNAL is exactly bakin\'s PLUGIN_CLIENT_EXTERNALS at the pinned ref', () => {
    expect(expected).not.toBeNull()
    expect([...CLIENT_EXTERNAL].sort()).toEqual([...expected!].sort())
  })
  test.if(expected === null && !required)('no Bakin checkout at .bakin-source (set BAKIN_SOURCE_DIR to compare locally)', () => {
    expect(expected).toBeNull()
  })

  test('CI compares against the pinned checkout BEFORE removing it', () => {
    const workflow = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    const compare = workflow.indexOf('Client externals match the pinned Bakin contract')
    const remove = workflow.indexOf('Remove the Bakin SDK source')
    expect(compare).toBeGreaterThan(-1)
    expect(remove).toBeGreaterThan(compare)
    expect(workflow.slice(compare, remove)).toContain("BAKIN_REQUIRE_SOURCE: '1'")
    expect(workflow.slice(compare, remove)).toContain('bun test test/client-externals-contract.test.ts')
  })
})

describe('unprovidedHostSubpath', () => {
  test('a sub-path of a host-provided package that the import map does not list is unprovided', () => {
    expect(unprovidedHostSubpath('zod/v4')).toBe('zod')
    expect(unprovidedHostSubpath('zod/mini')).toBe('zod')
    expect(unprovidedHostSubpath('@makinbakin/sdk/not-an-entry')).toBe('@makinbakin/sdk')
    expect(unprovidedHostSubpath('react-dom/server')).toBe('react-dom')
  })
  test('provided specifiers, other packages and relative paths are fine', () => {
    for (const provided of CLIENT_EXTERNAL) expect(unprovidedHostSubpath(provided)).toBeNull()
    expect(unprovidedHostSubpath('zod-to-json-schema')).toBeNull()
    expect(unprovidedHostSubpath('@makinbakin/sdk-tools')).toBeNull()
    expect(unprovidedHostSubpath('./zod/local')).toBeNull()
  })
  test('zod is part of the client external set', () => {
    expect(CLIENT_EXTERNAL).toContain('zod')
  })
})

describe('clientBundleProblem', () => {
  test('a bundle importing bare zod loads; string literals that look like imports are not imports', () => {
    expect(clientBundleProblem('demo', 'import{z}from"zod";console.log("import \'zod/v4\'","from \'zod/mini\'");')).toBeNull()
  })
  test('static, side-effect, re-export and dynamic sub-path imports are all caught', () => {
    for (const shape of ['import{z}from"zod/v4";', 'import"zod/v4";', 'export*from"zod/v4";', 'console.log("from");import("zod/v4");']) {
      expect(clientBundleProblem('demo', shape)).toMatch(/"zod\/v4".*only resolves "zod"/)
    }
  })
  test('an inlined zod is the supplemental finding', () => {
    expect(clientBundleProblem('demo', 'var a={_zod:{def:1}};a._zod.def;')).toMatch(/inlines its own zod/)
  })
})
