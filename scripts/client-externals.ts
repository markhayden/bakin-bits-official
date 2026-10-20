/**
 * The host-provided browser externals and the guard that keeps a client
 * bundle loadable against the host's import map (bakin #948, contract
 * react19-sdk-focused-v2).
 *
 * Bun's `external: ['zod']` also externalizes `zod/v4`, `zod/mini`, … and
 * `@makinbakin/sdk` matches `@makinbakin/sdk/anything`. The host import map
 * resolves EXACT specifiers only, so such a sub-path survives the build as a
 * bare import the browser cannot load. The guard parses the emitted bundle
 * (never pattern-matches it) and names every offender.
 */
import { Transpiler } from 'bun'

/**
 * Exactly what bakin's import map provides — `PLUGIN_CLIENT_EXTERNALS` in
 * bakin's `src/core/whiskit/externals.ts`, which `test/client-externals-contract.test.ts`
 * compares against the pinned Bakin checkout in CI. The list is the full SDK
 * surface: an entry missing here is still externalized by Bun's prefix
 * match, but then the guard below cannot tell it from an unprovided path.
 */
export const CLIENT_EXTERNAL = [
  'react', 'react-dom', 'react-dom/client',
  'react/jsx-runtime', 'react/jsx-dev-runtime',
  '@tanstack/react-router',
  '@makinbakin/sdk',
  '@makinbakin/sdk/ui', '@makinbakin/sdk/layout', '@makinbakin/sdk/patterns',
  '@makinbakin/sdk/charts', '@makinbakin/sdk/conversation', '@makinbakin/sdk/content',
  '@makinbakin/sdk/hooks', '@makinbakin/sdk/slots', '@makinbakin/sdk/types',
  '@makinbakin/sdk/utils', '@makinbakin/sdk/routing', '@makinbakin/sdk/navigation',
  '@makinbakin/sdk/internal',
  // bakin #948: the host serves ONE zod behind its import map (/vendor/zod.js).
  // Bare `zod` only; the map resolves no sub-path.
  'zod',
]

const HOST_PROVIDED_ROOTS = ['react', 'react-dom', '@tanstack/react-router', '@makinbakin/sdk', 'zod']

function packageRoot(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** The host-provided root a specifier belongs to without being provided exactly, or null. */
export function unprovidedHostSubpath(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (CLIENT_EXTERNAL.includes(specifier)) return null
  const root = packageRoot(specifier)
  return HOST_PROVIDED_ROOTS.includes(root) ? root : null
}

/** Every import/require/export-from specifier in a module, parsed by Bun's transpiler. */
export function collectImportSpecifiers(source: string): string[] {
  const transpiler = new Transpiler({ loader: 'js' })
  return transpiler
    .scanImports(source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source)
    .map((entry) => entry.path)
    .filter((specifier): specifier is string => typeof specifier === 'string' && specifier.length > 0)
}

/** zod 4's schema internals: present in a client bundle only when it inlined its own zod. */
export const INLINED_ZOD_MARKER = '_zod.def'

/**
 * Why an emitted client bundle cannot load against the host import map, or
 * null when it can: unprovided host sub-paths (parsed, covers dependencies
 * and every import shape) and, as a supplemental check, an inlined zod.
 */
export function clientBundleProblem(pluginId: string, bundle: string): string | null {
  const unresolvable = new Map<string, string>()
  for (const specifier of collectImportSpecifiers(bundle)) {
    const root = unprovidedHostSubpath(specifier)
    if (root) unresolvable.set(specifier, root)
  }
  if (unresolvable.size > 0) {
    const detail = [...unresolvable].map(([specifier, root]) => `"${specifier}" (the host import map only resolves "${root}"${root === '@makinbakin/sdk' ? ' and its published entries' : ''})`).join(', ')
    return `client bundle for ${pluginId} imports ${detail}. Bun externalizes host-provided packages by prefix, so these stay bare imports the browser cannot resolve. Import the bare package ("zod", not "zod/v4") or a published @makinbakin/sdk entry.`
  }
  if (bundle.includes(INLINED_ZOD_MARKER)) {
    return `client bundle for ${pluginId} inlines its own zod (found "${INLINED_ZOD_MARKER}"). The host provides zod through its import map (bakin #948); keep 'zod' in CLIENT_EXTERNAL and import the bare package.`
  }
  return null
}
