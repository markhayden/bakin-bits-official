import { describe, expect, it } from 'bun:test'
import { builtinModules } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const PLUGINS = ['messaging', 'projects'] as const

const HOST_EXTERNALS = new Set([
  '@makinbakin/sdk',
  '@makinbakin/sdk/components',
  '@makinbakin/sdk/hooks',
  '@makinbakin/sdk/slots',
  '@makinbakin/sdk/types',
  '@makinbakin/sdk/ui',
  '@makinbakin/sdk/utils',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
])

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'tests') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full))
      continue
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

function importedSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf-8')
  const specs: string[] = []
  const re = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) specs.push(match[1])
  return specs
}

function packageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (NODE_BUILTINS.has(specifier)) return null
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  if (NODE_BUILTINS.has(bare.split('/')[0])) return null
  if (HOST_EXTERNALS.has(specifier) || specifier.startsWith('@makinbakin/sdk/')) return null
  const parts = bare.split('/')
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function registeredRoutes(pluginDir: string): string[] {
  const source = readFileSync(join(pluginDir, 'index.ts'), 'utf-8')
  const routes: string[] = []
  const re = /ctx\.registerRoute\(\{\s*path:\s*['"]([^'"]+)['"][\s\S]*?method:\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) routes.push(`${match[2].toUpperCase()} ${match[1]}`)
  return routes.sort()
}

describe('official plugin package contracts', () => {
  for (const plugin of PLUGINS) {
    it(`${plugin} declares every non-host runtime package it imports`, () => {
      const pluginDir = join(import.meta.dir, plugin)
      expect(statSync(pluginDir).isDirectory()).toBe(true)

      const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ])

      const missing = new Map<string, Set<string>>()
      for (const file of walkSourceFiles(pluginDir)) {
        for (const specifier of importedSpecifiers(file)) {
          const pkgName = packageName(specifier)
          if (!pkgName || declared.has(pkgName)) continue
          const refs = missing.get(pkgName) ?? new Set<string>()
          refs.add(relative(pluginDir, file))
          missing.set(pkgName, refs)
        }
      }

      expect(
        [...missing].map(([pkgName, refs]) => `${pkgName}: ${[...refs].sort().join(', ')}`),
      ).toEqual([])
    })

    it(`${plugin} declares its auto-registered search API route`, () => {
      const pluginDir = join(import.meta.dir, plugin)
      const manifest = JSON.parse(readFileSync(join(pluginDir, 'bakin-plugin.json'), 'utf-8')) as {
        contributes?: {
          apiRoutes?: Array<{ method?: string; path?: string }>
        }
      }
      expect(manifest.contributes?.apiRoutes).toContainEqual(
        expect.objectContaining({ method: 'GET', path: '/search' }),
      )
    })

    it(`${plugin} declares every registered API route`, () => {
      const pluginDir = join(import.meta.dir, plugin)
      const manifest = JSON.parse(readFileSync(join(pluginDir, 'bakin-plugin.json'), 'utf-8')) as {
        contributes?: {
          apiRoutes?: Array<{ method?: string; path?: string }>
        }
      }
      const declared = new Set(
        (manifest.contributes?.apiRoutes ?? []).map(route => `${route.method?.toUpperCase()} ${route.path}`),
      )
      const missing = registeredRoutes(pluginDir).filter(route => !declared.has(route))

      expect(missing).toEqual([])
    })
  }
})
