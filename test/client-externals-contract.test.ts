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
  test.if(expected !== null)('CLIENT_EXTERNAL is exactly bakin\'s PLUGIN_CLIENT_EXTERNALS at the pinned ref', () => {
    expect([...CLIENT_EXTERNAL].sort()).toEqual([...expected!].sort())
  })
  test.if(expected === null)('no Bakin checkout at .bakin-source (set BAKIN_SOURCE_DIR to compare locally)', () => {
    expect(expected).toBeNull()
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
